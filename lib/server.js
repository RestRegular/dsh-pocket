/**
 * dsh-pocket — 手机端 HTTP 服务。
 *
 * 这是一个独立于 DSH Web 引擎的小型 HTTP 服务：它只服务 Pocket 的移动页面
 * 及一组面向会话的 JSON/SSE 接口。独立监听的意义在于隧道可以直接指向它，
 * 而不用把整个桌面 Web GUI 暴露出去；同时它也能只绑定回环地址。
 *
 * 与 DSH 的桥接全部走宿主服务：
 *   `sessionController.list / follow / page / prompt / cancel`
 *   `sessionQuery.readTitleSnapshots`
 *
 * 鉴权：URL 里的 `?token=`、HttpOnly Cookie、`X-Pocket-Token` 三者之一。
 * 令牌 128 位随机数，首次运行生成并落到 `$DSH_HOME/pocket/state.json`。
 *
 * @module dsh-pocket/server
 */

import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, networkInterfaces } from 'node:os';
import { basename, dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TunnelManager } from './tunnel.js';
import { KeepAwake } from './awake.js';
import { GuiProxy } from './gui-proxy.js';
import { describeRestart, describeShutdown, requestRestart, requestShutdown } from './restart.js';
import { ensureToken, loadState, rotateToken, saveDisplaySettings, saveKeepAwake, saveMobileLayout, saveState, saveSurface, saveTunnelPreference } from './state.js';
import { encodeQrMatrix } from './qrcode.js';
import { WebSocketServer } from 'ws';

/** 包根目录（lib/server.js 的上一级）。 */
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 移动页面静态资源目录。 */
const WEB_ROOT = join(PACKAGE_ROOT, 'web');

/** 访问令牌的 Cookie 名。 */
export const COOKIE_NAME = 'dsh_pocket';

/** 会话跟随一次最多带回多少条消息。 */
const FOLLOW_MAX_MESSAGES = 20;

/** 手机端默认的截断设置；数值单位是字符。 */
const DEFAULT_DISPLAY = Object.freeze({
  truncateTools: true,
  truncateAssistant: true,
  truncateReasoning: true,
  limit: 6_000,
});

/** 截断长度允许的范围（字符）。 */
const DISPLAY_LIMIT_MIN = 500;
const DISPLAY_LIMIT_MAX = 50_000;

/** 每个 snapshot-batch 携带的事件数。 */
const SNAPSHOT_BATCH_RECORDS = 10;

/** 截断标记。 */
const TRUNCATED_MARK = '\n…（Pocket 已截断，完整内容请在桌面端查看）';

/**
 * 归一化显示/截断设置；缺省字段回退到 base。
 * @param {unknown} raw
 * @param {{ truncateTools: boolean, truncateAssistant: boolean, truncateReasoning: boolean, limit: number }} [base]
 * @returns {{ truncateTools: boolean, truncateAssistant: boolean, truncateReasoning: boolean, limit: number }}
 */
function normalizeDisplay(raw, base = DEFAULT_DISPLAY) {
  const value = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const number = Number(value.limit);
  const limit = Number.isFinite(number)
    ? Math.min(DISPLAY_LIMIT_MAX, Math.max(DISPLAY_LIMIT_MIN, Math.round(number)))
    : base.limit;
  return {
    truncateTools: typeof value.truncateTools === 'boolean' ? value.truncateTools : base.truncateTools,
    truncateAssistant: typeof value.truncateAssistant === 'boolean' ? value.truncateAssistant : base.truncateAssistant,
    truncateReasoning: typeof value.truncateReasoning === 'boolean' ? value.truncateReasoning : base.truncateReasoning,
    limit,
  };
}

/**
 * POST 请求体上限。
 *
 * 图片消息以 base64 内嵌在 JSON 里：手机端会先把照片压到 ~1.5 MB，
 * 4 张加文本仍可能到 10 MB 左右，这里留 32 MB 余量。超限时返回 413，
 * 不再直接断开连接——否则 Safari 只会报一个含糊的 “Load failed”。
 */
const BODY_LIMIT = 32 * 1024 * 1024;

/** 账户余额缓存时间：首页轮询不会反复打平台接口。 */
const BALANCE_CACHE_MS = 60_000;

/** 账户接口要求的客户端身份；与 DSH Web 客户端上报的构建版本保持一致。 */
const ACCOUNT_CLIENT_VERSION = '0.2.1-rc.2';

/** 静态资源的 MIME。 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** 允许从会话工作区读取并直接展示的图片类型。 */
const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
};

/**
 * 下载时声明的 MIME。带 `Content-Disposition: attachment`，浏览器不会直接
 * 渲染；保留常见类型只是让手机上的「文件」App 能正确关联打开方式。
 */
const DOWNLOAD_MIME = {
  ...IMAGE_MIME,
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.zip': 'application/zip',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};

/**
 * 生成同时兼容老浏览器的 ASCII 文件名与 RFC 5987 的 UTF-8 文件名。
 * @param {string} name
 * @returns {string}
 */
function contentDisposition(name) {
  const fallback = name
    .replace(/[^\x20-\x7e]/gu, '_')
    .replace(/["\\]/gu, '_')
    .trim() || 'download';
  const encoded = encodeURIComponent(name).replace(
    /['()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** 手机文件树一次最多返回多少项。 */
const FILE_LIST_LIMIT = 1000;

/** 文本预览最多读取多少字节；更大的文件截断显示。 */
const TEXT_PREVIEW_LIMIT = 400 * 1024;

/**
 * 这些扩展名按二进制处理，避免把图片/压缩包塞进文本预览。
 * 没有列出的扩展名仍会用 NUL 字节嗅探一次。
 */
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.bmp', '.tif', '.tiff',
  '.pdf', '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.tar',
  '.mp3', '.wav', '.ogg', '.m4a', '.flac',
  '.mp4', '.mov', '.mkv', '.avi', '.webm',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.exe', '.dll', '.so', '.dylib', '.class', '.jar', '.wasm', '.node',
  '.db', '.sqlite', '.sqlite3', '.bin', '.dat', '.pyc', '.zst',
]);

/**
 * 创建一个带 HTTP 状态码的错误；路由会把 statusCode 透传给手机端。
 * @param {string} message
 * @param {number} statusCode
 * @returns {Error & { statusCode: number }}
 */
function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

/**
 * Windows 盘符/路径大小写不敏感；Linux/macOS 按原样比较。
 */
const CASE_INSENSITIVE_FS = process.platform === 'win32';

/**
 * 判断 child 是否位于 root 子树内（Windows 大小写不敏感）。
 * @param {string} child
 * @param {string} root
 * @returns {boolean}
 */
function insideRoot(child, root) {
  const value = CASE_INSENSITIVE_FS ? child.toLowerCase() : child;
  const base = CASE_INSENSITIVE_FS ? root.toLowerCase() : root;
  return value === base || value.startsWith(`${base}${sep}`);
}

/**
 * 工作区根目录的比较 key。
 * @param {string} path
 * @returns {string}
 */
function rootKey(path) {
  const value = resolve(path);
  return CASE_INSENSITIVE_FS ? value.toLowerCase() : value;
}

/**
 * 相对路径统一用 `/` 给手机端，桌面端也能直接用于 @ 引用。
 * @param {string} root
 * @param {string} target
 * @returns {string}
 */
function relativePath(root, target) {
  return relative(root, target).split(sep).join('/');
}

/**
 * 粗略判断文件是否适合文本预览。
 * @param {string} name
 * @returns {boolean}
 */
function textCandidate(name) {
  return !BINARY_EXT.has(extname(name).toLowerCase());
}

/** 移动页面的安全策略。 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob:",
  "connect-src 'self' ws: wss:",
  "font-src 'self' data:",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * 发送 JSON。
 * @param {import('node:http').ServerResponse} res
 * @param {unknown} payload
 * @param {number} status
 */
function sendJson(res, payload, status = 200) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/**
 * 发送 HTML。
 * @param {import('node:http').ServerResponse} res
 * @param {string} body
 * @param {number} status
 * @param {Record<string, string>} extra
 */
function sendHtml(res, body, status = 200, extra = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': CSP,
    ...extra,
  });
  res.end(body);
}

/**
 * 读取请求体。
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limit
 * @returns {Promise<string>}
 */
function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > limit) {
        settled = true;
        chunks.length = 0;
        rejectPromise(Object.assign(
          new Error(`请求体过大（上限 ${Math.floor(limit / 1024 / 1024)} MB）`),
          { statusCode: 413 },
        ));
        // 把剩余字节读掉再响应，避免客户端还在上传时连接被重置。
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) resolvePromise(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error) => {
      if (!settled) rejectPromise(error);
    });
  });
}

/**
 * 解析 JSON 请求体，空体返回 {}。
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<any>}
 */
async function readJson(req) {
  const text = await readBody(req);
  if (text.trim().length === 0) return {};
  return JSON.parse(text);
}

/**
 * 常数时间比较两个字符串。
 * @param {string | undefined} a
 * @param {string} b
 * @returns {boolean}
 */
function tokenEquals(a, b) {
  if (typeof a !== 'string' || a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

/**
 * 从 Cookie 头里取一个值。
 * @param {string | undefined} header
 * @param {string} name
 * @returns {string | undefined}
 */
function readCookie(header, name) {
  if (typeof header !== 'string') return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

/**
 * 本机所有非内部 IPv4 地址及其网卡名。虚拟网卡排在物理网卡之后；
 * 面板可以让用户在这些地址之间切换二维码/分享用的局域网 IP。
 * @returns {{ name: string, address: string, virtual: boolean }[]}
 */
function lanInterfaces() {
  const virtual = /(vEthernet|VMware|VirtualBox|Hyper-V|Loopback|WSL|Tailscale|ZeroTier|Docker|TAP-)/iu;
  const rows = [];
  const interfaces = networkInterfaces();
  for (const [name, list] of Object.entries(interfaces)) {
    for (const info of list ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      if (info.address.startsWith('169.254.')) continue;
      rows.push({ name, address: info.address, virtual: virtual.test(name) });
    }
  }
  return rows.sort((left, right) => Number(left.virtual) - Number(right.virtual));
}

/** 最近生成的二维码，避免面板每 3 秒轮询都重新编码。 */
const qrCache = new Map();

/**
 * 把文本编码成 SVG data URL 的二维码。
 * @param {string} text
 * @param {number} size
 * @returns {string}
 */
function qrDataUrl(text, size = 240) {
  const key = `${size}:${text}`;
  const cached = qrCache.get(key);
  if (cached !== undefined) return cached;
  let result;
  try {
    const { count, modules } = encodeQrMatrix(text);
    const quiet = 4;
    const total = count + quiet * 2;
    let path = '';
    for (let row = 0; row < count; row++) {
      for (let column = 0; column < count; column++) {
        if (modules[row][column] === 1) path += `M${column + quiet} ${row + quiet}h1v1h-1z`;
      }
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${size}" height="${size}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#ffffff"/><path d="${path}" fill="#0b0e14"/></svg>`;
    result = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  } catch {
    result = '';
  }
  if (qrCache.size > 8) qrCache.clear();
  qrCache.set(key, result);
  return result;
}

/**
 * 递归截断 JSON 里的超长字符串，避免一条工具输出把整条 SSE 撑到几 MB。
 * @param {unknown} value
 * @param {number} limit
 * @param {number} depth
 * @returns {unknown}
 */
function shrinkValue(value, limit, depth = 0) {
  if (depth > 8) return value;
  if (typeof value === 'string') {
    return value.length > limit ? `${value.slice(0, limit)}${TRUNCATED_MARK}` : value;
  }
  if (Array.isArray(value)) return value.map((item) => shrinkValue(item, limit, depth + 1));
  if (value !== null && typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) result[key] = shrinkValue(item, limit, depth + 1);
    return result;
  }
  return value;
}

/**
 * 按类别压缩助手消息内容：回复、思考、工具参数分别受开关控制。
 * @param {unknown} content
 * @param {{ truncateTools: boolean, truncateAssistant: boolean, truncateReasoning: boolean, limit: number }} display
 * @returns {unknown}
 */
function shrinkAssistantContent(content, display) {
  if (!Array.isArray(content)) return shrinkValue(content, display.limit);
  return content.map((block) => {
    const type = block?.type;
    if (type === 'text') {
      return display.truncateAssistant ? shrinkValue(block, display.limit) : block;
    }
    if (type === 'reasoning') {
      return display.truncateReasoning ? shrinkValue(block, display.limit) : block;
    }
    // tool-call 等其余块归属工具输出；关闭工具截断时原样保留。
    return display.truncateTools ? shrinkValue(block, display.limit) : block;
  });
}

/**
 * 把一条原始会话事件压缩成手机端真正需要的形状。
 *
 * 这是“历史打不开”的关键修复：原始 follow 快照里 `request/header`（完整
 * 工具目录）和 `assistant/message.stream`（逐 token 时间轴）往往占 >70%，
 * 一条 200 KB 的 SSE 事件经隧道传输时，手机会长时间停在空白页。控制类事件
 * 全部丢弃，消息只保留渲染所需的 content/source/usage/error。
 *
 * @param {any} event
 * @param {{ truncateTools: boolean, truncateAssistant: boolean, truncateReasoning: boolean, limit: number }} display
 * @returns {any | undefined}
 */
function compactEvent(event, display) {
  if (event === null || typeof event !== 'object') return undefined;
  const base = { type: event.type, seq: event.seq, time: event.time };
  const data = event.data ?? {};
  switch (event.type) {
    case 'user/message':
      if (data.source?.kind !== 'user') return undefined;
      return { ...base, data: { source: { kind: 'user' }, content: shrinkValue(data.content, display.limit) } };
    case 'assistant/message': {
      const message = data.message ?? {};
      return {
        ...base,
        data: {
          message: { content: shrinkAssistantContent(message.content, display) },
          ...(data.usage === undefined ? {} : { usage: data.usage }),
          ...(data.interrupted === true ? { interrupted: true } : {}),
        },
      };
    }
    case 'tool/result': {
      const message = data.message ?? {};
      const callId = message.toolCallId ?? message.source?.callId;
      return {
        ...base,
        data: {
          message: {
            content: display.truncateTools ? shrinkValue(message.content, display.limit) : message.content,
            toolCallId: callId,
            isError: message.isError === true,
          },
          ...(data.error === undefined ? {} : {
            error: { name: data.error.name, code: data.error.code, reason: data.error.reason },
          }),
        },
      };
    }
    case 'turn/start':
    case 'turn/end':
      return { ...base, data: { turn: data.turn } };
    case 'session/title':
      return { ...base, data: { title: data.title } };
    default:
      return undefined;
  }
}

/**
 * 压缩整个 follow 帧；返回 undefined 表示这一帧对手机端没有意义，直接跳过。
 * @param {any} frame
 * @param {{ truncateTools: boolean, truncateAssistant: boolean, truncateReasoning: boolean, limit: number }} display
 * @returns {any | undefined}
 */
function compactFrame(frame, display) {
  if (frame === null || typeof frame !== 'object') return undefined;
  if (frame.type === 'snapshot') {
    const records = [];
    for (const record of frame.records ?? []) {
      if (record?.type !== 'event') continue;
      const event = compactEvent(record.event, display);
      if (event !== undefined) records.push({ type: 'event', event });
    }
    return {
      type: 'snapshot',
      header: frame.header,
      cursor: frame.cursor,
      records,
      hasMore: frame.hasMore === true,
    };
  }
  if (frame.type === 'event') {
    const event = compactEvent(frame.event, display);
    return event === undefined ? undefined : { type: 'event', event };
  }
  if (frame.type === 'assistant-stream') return frame;
  return undefined;
}

/**
 * 时间戳格式化成手机端可读的相对时间（服务端不做，客户端做；这里保留数字）。
 * @param {number | undefined} time
 * @returns {string}
 */
function isoTime(time) {
  return typeof time === 'number' ? new Date(time).toISOString() : '';
}

/** 解锁页：没有有效令牌时显示。 */
const UNLOCK_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Pocket · 解锁</title>
<style>
:root{color-scheme:dark}
body{margin:0;min-height:100dvh;display:flex;align-items:center;justify-content:center;background:#0b0e14;color:#e8ecf4;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
.card{width:min(360px,86vw);padding:28px 24px;border-radius:20px;background:#121722;border:1px solid #232b3a;box-shadow:0 20px 60px rgba(0,0,0,.4)}
h1{margin:0 0 6px;font-size:20px;letter-spacing:.2px}
p{margin:0 0 20px;color:#8b97ab;font-size:13px}
input{width:100%;box-sizing:border-box;padding:12px 14px;border-radius:12px;border:1px solid #2a3446;background:#0b0e14;color:#e8ecf4;font:inherit;outline:none}
input:focus{border-color:#4f8cff}
button{width:100%;margin-top:12px;padding:12px 14px;border:0;border-radius:12px;background:#3b70e8;color:#fff;font:600 15px/1.4 inherit;cursor:pointer}
.hint{margin-top:14px;color:#69758a;font-size:12px;line-height:1.6}
</style>
</head>
<body>
<form class="card" method="post" action="/api/unlock">
  <h1>Pocket</h1>
  <p>输入桌面端「Pocket 随身访问」面板里显示的访问令牌。</p>
  <input name="token" type="password" inputmode="text" autocomplete="off" placeholder="访问令牌" autofocus required>
  <button type="submit">解锁</button>
  <div class="hint">令牌保存在本机 ~/.dsh/pocket/state.json，也可以在面板里轮换。</div>
</form>
</body>
</html>`;

/** 桌面直通模式下的兜底页：代理失败时给出回到轻量页的入口。 */
const PROXY_FAIL_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Pocket · 桌面直通不可用</title>
<style>
:root{color-scheme:dark}
body{margin:0;min-height:100dvh;display:flex;align-items:center;justify-content:center;background:#0b0e14;color:#e8ecf4;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
.card{width:min(380px,86vw);padding:26px 22px;border-radius:20px;background:#121722;border:1px solid #232b3a}
h1{margin:0 0 8px;font-size:18px}
p{margin:0 0 16px;color:#8b97ab;font-size:13px;line-height:1.7}
a{display:block;text-align:center;padding:11px 14px;border-radius:11px;background:#3b70e8;color:#fff;text-decoration:none;font-weight:600}
</style>
</head>
<body>
<div class="card">
  <h1>桌面直通暂时不可用</h1>
  <p>Pocket 没能连上桌面 Web 界面。可以回到轻量界面继续使用；桌面端也可能重启过，刷新页面再试。</p>
  <a href="/__pocket/surface?to=mobile">回到轻量界面</a>
</div>
</body>
</html>`;

/** 手机端页面。 */
async function readAsset(relative) {
  const safe = normalize(relative).replace(/^([/\\])+/u, '');
  const full = join(WEB_ROOT, safe);
  if (!full.startsWith(WEB_ROOT + sep)) return undefined;
  try {
    return await readFile(full);
  } catch {
    return undefined;
  }
}

/**
 * Pocket 移动服务。
 */
export class PocketServer {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @param {{
   *   port: number,
   *   lan: boolean,
   *   tunnel: string,
   *   autoStart: boolean,
   *   token?: string,
   *   publicUrl?: string,
   *   cloudflaredPath?: string,
   *   customCommand?: string,
   *   keepAwake?: boolean,
   *   keepAwakeDisplay?: boolean,
   *   surface?: 'mobile' | 'desktop',
   *   mobileLayout?: boolean,
   * }} config
   * @param {(message: string) => void} [log]
   */
  constructor(ctx, config, log) {
    this.ctx = ctx;
    this.config = config;
    this.log = log ?? (() => {});
    this.token = '';
    this.lanAddress = undefined;
    this.server = undefined;
    this.wss = undefined;
    this.port = 0;
    this.bindHost = '';
    this.startedAt = 0;
    this.starting = undefined;
    /** 正在跟随的 SSE 连接；关闭服务时先中止它们，避免 close() 一直等长连接。 */
    this.followers = new Set();
    /** 每个会话的移动端 WebSocket 集合，用于把前台提问/审批推给手机。 */
    this.sessionSockets = new Map();
    /** 首页事件流：别的会话被提问/审批阻塞时，用它在顶部弹提示。 */
    this.notificationSockets = new Set();
    /** 等待手机回答的前台提问/审批。key 是 requestId。 */
    this.pendingInteractions = new Map();
    /** 提问/审批 waterfall 监听器的 disposer。 */
    this.interactionDisposers = [];
    /** 手机端界面模式：`mobile` 用 Pocket 自己的页面，`desktop` 反代桌面 Web GUI。 */
    this.surface = config.surface === 'desktop' ? 'desktop' : 'mobile';
    /** 桌面直通是否注入窄屏适配样式（抽屉侧栏、全屏设置页）。 */
    this.mobileLayout = config.mobileLayout !== false;
    /** 桌面 Web GUI 反代器。 */
    this.gui = new GuiProxy(ctx, (message) => this.log(message), {
      shouldInject: () => this.surface === 'desktop' && this.mobileLayout !== false,
    });
    /** 账户余额缓存（列表首页读取，避免每次轮询都请求平台）。 */
    this.balanceCache = { at: 0, value: undefined, pending: undefined };
    /** 会话标题/目录缓存：列表每 8 秒轮询一次，冷会话折标题不值得重复读盘。 */
    this.titleCache = new Map();
    /** 已登记工作区的根目录（小写），首页文件树只允许浏览这些路径。 */
    this.workspaceRoots = new Set();
    /** 手机端显示/截断设置；启动时从 state.json 恢复。 */
    this.display = normalizeDisplay(undefined);
    this.tunnel = new TunnelManager({
      port: 0,
      mode: config.tunnel,
      cloudflaredPath: config.cloudflaredPath,
      customCommand: config.customCommand,
      publicUrl: config.publicUrl,
      sshHost: config.sshHost,
      sshUser: config.sshUser,
      sshPort: config.sshPort,
      sshKeyPath: config.sshKeyPath,
      sshRemotePort: config.sshRemotePort,
      sshExposePort: config.sshExposePort,
      sshExposeHost: config.sshExposeHost,
      sshPublicUrl: config.sshPublicUrl,
      onStatus: (status) => {
        if (status.state === 'error' && status.error !== undefined) {
          this.log(`pocket: tunnel error: ${status.error}`);
        }
      },
      log: (message) => this.log(message),
    });
    /** 「保持电脑常亮」子进程；开关状态由面板/手机控制并持久化。 */
    this.awake = new KeepAwake(
      (message) => this.log(message),
      { display: config.keepAwakeDisplay !== false },
    );
  }

  /** 当前监听端口。 */
  get activePort() {
    return this.port;
  }

  /** 服务是否在监听。 */
  get listening() {
    return this.server !== undefined && this.server.listening;
  }

  /**
   * 启动 HTTP 服务（幂等）。
   * @returns {Promise<void>}
   */
  async start() {
    if (this.listening) return;
    if (this.starting !== undefined) return this.starting;
    this.starting = this.#start().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  async #start() {
    this.token = await ensureToken(this.config.token);
    this.startedAt = Date.now();
    const preferences = await loadState();
    this.lanAddress = preferences.lanAddress;
    this.display = normalizeDisplay(preferences.display);
    if (preferences.tunnel === 'cloudflared' || preferences.tunnel === 'ssh' || preferences.tunnel === 'auto') {
      this.config.tunnel = preferences.tunnel;
      this.tunnel.options.mode = preferences.tunnel;
    }
    if (preferences.sshHost !== undefined) {
      this.config.sshHost = preferences.sshHost;
      this.tunnel.options.sshHost = preferences.sshHost;
    }
    if (preferences.surface === 'desktop' || preferences.surface === 'mobile') {
      this.surface = preferences.surface;
    }
    if (typeof preferences.mobileLayout === 'boolean') {
      this.mobileLayout = preferences.mobileLayout;
    }

    const server = createServer((req, res) => {
      void this.#handle(req, res).catch((error) => {
        this.log(`pocket: request failed: ${error?.stack ?? error}`);
        if (!res.headersSent) sendJson(res, { ok: false, error: String(error?.message ?? error) }, 500);
        else res.end();
      });
    });
    server.on('clientError', (error, socket) => {
      this.log(`pocket: client error: ${error.message}`);
      try {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      } catch {
        /* ignore */
      }
    });

    const preferred = Number.isInteger(this.config.port) && this.config.port >= 0 ? this.config.port : 8790;
    const host = this.config.lan ? '0.0.0.0' : '127.0.0.1';
    const candidates = preferred === 0 ? [0] : Array.from({ length: 10 }, (_, index) => preferred + index);

    let lastError;
    for (const port of candidates) {
      try {
        await new Promise((resolvePromise, rejectPromise) => {
          const onError = (error) => {
            server.removeListener('listening', onListening);
            rejectPromise(error);
          };
          const onListening = () => {
            server.removeListener('error', onError);
            resolvePromise();
          };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen(port, host);
        });
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        if (error?.code !== 'EADDRINUSE') break;
      }
    }
    if (lastError !== undefined) {
      throw new Error(`无法监听 ${host}:${preferred}（${lastError.code ?? lastError.message}）`);
    }

    this.server = server;
    this.port = server.address().port;
    this.bindHost = host;
    this.tunnel.options.port = this.port;
    this.wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      this.#handleUpgrade(req, socket, head);
    });
    this.log(`pocket: mobile server on http://${host}:${this.port}`);
    this.#installInteractions();

    if (this.config.tunnel !== 'off' && this.config.autoStart) {
      void this.startTunnel();
    }

    // 常亮开关：状态文件里的显式选择优先，其次插件配置；失败只记录，不影响服务。
    const keepAwake = preferences.keepAwake ?? (this.config.keepAwake === true);
    if (keepAwake === true) {
      void this.awake.start().catch((error) => {
        this.log(`pocket: 保持电脑常亮启动失败：${error?.message ?? error}`);
      });
    }
  }

  /** 关闭 HTTP 服务与隧道。 */
  async stop() {
    this.awake.stop();
    this.tunnel.stop();
    this.gui.dispose();
    for (const dispose of this.interactionDisposers.splice(0)) {
      try {
        dispose();
      } catch {
        /* ignore */
      }
    }
    for (const pending of this.pendingInteractions.values()) {
      pending.close?.();
    }
    this.pendingInteractions.clear();
    this.sessionSockets.clear();
    this.notificationSockets.clear();
    for (const abort of this.followers) abort.abort();
    this.followers.clear();
    const server = this.server;
    this.server = undefined;
    this.port = 0;
    const wss = this.wss;
    this.wss = undefined;
    if (wss !== undefined) {
      for (const client of wss.clients) {
        try {
          client.close();
        } catch {
          /* ignore */
        }
      }
      wss.close();
    }
    if (server !== undefined) {
      await new Promise((resolvePromise) => {
        server.close(() => resolvePromise());
        server.closeAllConnections?.();
      });
    }
  }

  /** 启动隧道（幂等）。 */
  async startTunnel() {
    if (!this.listening) return this.tunnel.snapshot();
    return this.tunnel.start();
  }

  /**
   * 在桌面面板切换公网入口。
   * @param {string} provider - `cloudflared` / `ssh` / `auto`
   * @param {string | undefined} sshHost
   * @returns {Promise<object>}
   */
  async switchTunnel(provider, sshHost) {
    const mode = provider === 'ssh' ? 'ssh' : provider === 'auto' ? 'auto' : 'cloudflared';
    const host = typeof sshHost === 'string' ? sshHost.trim() : '';
    if (host.length > 0 && (!/^[A-Za-z0-9._:@[\]-]+$/u.test(host) || host.startsWith('-'))) {
      throw new Error('服务器地址格式不正确');
    }
    if (mode === 'ssh' && host.length === 0) throw new Error('请填写服务器 IP 或域名');
    if (host.length > 0) {
      this.config.sshHost = host;
      this.tunnel.options.sshHost = host;
    }
    this.config.tunnel = mode;
    this.tunnel.options.mode = mode;
    await saveTunnelPreference(mode, this.config.sshHost);
    this.stopTunnel();
    await this.startTunnel();
    return this.tunnel.snapshot();
  }

  /** 停止隧道。 */
  stopTunnel() {
    this.tunnel.stop();
  }

  /** 轮换令牌。 */
  async rotateToken() {
    this.token = await rotateToken();
    return this.token;
  }

  /**
   * 打开/关闭「保持电脑常亮」，并把选择持久化。
   * @param {boolean} enabled
   * @returns {Promise<object>} 最新常亮状态
   */
  async setKeepAwake(enabled) {
    const value = enabled === true;
    await this.awake.setEnabled(value);
    await saveKeepAwake(value);
    return this.awake.status();
  }

  /**
   * 切换手机端界面：轻量页 / 桌面直通。切直通前先验证能换到 GUI 凭据，
   * 避免把手机切到一个打不开的页面。
   * @param {unknown} mode
   * @returns {Promise<'mobile' | 'desktop'>}
   */
  async setSurface(mode) {
    const next = mode === 'desktop' ? 'desktop' : 'mobile';
    if (next === this.surface) return this.surface;
    if (next === 'desktop') {
      if (this.gui.available() === undefined) {
        throw new Error('桌面 Web 界面没有在运行，无法直通');
      }
      await this.gui.cookieValue(true);
    }
    this.surface = next;
    await saveSurface(next);
    return next;
  }

  /**
   * 开关桌面直通的窄屏适配（抽屉侧栏、全屏设置页），并持久化。
   * @param {unknown} enabled
   * @returns {Promise<boolean>}
   */
  async setMobileLayout(enabled) {
    this.mobileLayout = enabled !== false;
    await saveMobileLayout(this.mobileLayout);
    return this.mobileLayout;
  }

  /**
   * 读取手机端显示/截断设置。
   * @returns {{ truncateTools: boolean, truncateAssistant: boolean, truncateReasoning: boolean, limit: number }}
   */
  displaySettings() {
    return { ...this.display };
  }

  /**
   * 更新手机端显示/截断设置并落盘；只传部分字段时保留其余值。
   * @param {unknown} patch
   * @returns {Promise<{ truncateTools: boolean, truncateAssistant: boolean, truncateReasoning: boolean, limit: number }>}
   */
  async setDisplay(patch) {
    const value = patch !== null && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
    this.display = normalizeDisplay({ ...this.display, ...value }, this.display);
    await saveDisplaySettings(this.display);
    return this.displaySettings();
  }

  /**
   * 切换二维码/分享优先使用的局域网 IP；空字符串表示自动选第一个。
   * @param {string} address
   * @returns {Promise<string | undefined>}
   */
  async setLanAddress(address) {
    const normalized = typeof address === 'string' ? address.trim() : '';
    if (normalized.length > 0 && !lanInterfaces().some((row) => row.address === normalized)) {
      throw new Error(`本机没有这个局域网地址：${normalized}`);
    }
    this.lanAddress = normalized.length > 0 ? normalized : undefined;
    const state = await loadState();
    const next = { ...state };
    if (this.lanAddress === undefined) delete next.lanAddress;
    else next.lanAddress = this.lanAddress;
    await saveState(next);
    return this.lanAddress;
  }

  /**
   * @param {{ address: string, virtual: boolean }[]} rows
   * @returns {string | undefined}
   */
  #selectedLan(rows) {
    if (this.lanAddress !== undefined && rows.some((row) => row.address === this.lanAddress)) {
      return this.lanAddress;
    }
    return rows.find((row) => !row.virtual)?.address ?? rows[0]?.address;
  }

  /**
   * 当前状态下所有可用的入口地址。
   * @param {boolean} withToken
   * @returns {{
   *   local: string,
   *   lan: string[],
   *   lanSelected: string | null,
   *   lanOptions: object[],
   *   publicUrl?: string,
   *   access: { local: string, lan: string[], publicUrl?: string },
   * }}
   */
  urls(withToken) {
    const suffix = withToken ? `/?token=${encodeURIComponent(this.token)}` : '/';
    const local = `http://127.0.0.1:${this.port}${suffix}`;
    const rows = lanInterfaces();
    const selected = this.#selectedLan(rows);
    const options = rows.map((row) => ({
      name: row.name,
      address: row.address,
      virtual: row.virtual,
      url: `http://${row.address}:${this.port}${suffix}`,
    }));
    const selectedOption = options.find((option) => option.address === selected);
    const lan = [];
    if (selectedOption !== undefined) lan.push(selectedOption.url);
    for (const option of options) {
      if (option.address === selected) continue;
      if (option.virtual && options.some((item) => !item.virtual)) continue;
      lan.push(option.url);
    }
    const publicUrl = this.tunnel.snapshot().url;
    return {
      local,
      lan,
      lanSelected: selected ?? null,
      lanOptions: options,
      publicUrl: publicUrl === undefined ? undefined : `${publicUrl}${suffix}`,
      access: {
        local: `http://127.0.0.1:${this.port}${suffix}`,
        lan,
        publicUrl: publicUrl === undefined ? undefined : `${publicUrl}${suffix}`,
      },
    };
  }

  /**
   * 手机端可用的能力清单；旧客户端用 `features` 做入口门控。
   * @returns {{ controls: boolean, questions: boolean, images: boolean, files: boolean, fileTree: boolean, sessionActions: boolean, balance: boolean, notifications: boolean, awake: boolean, displaySettings: boolean, desktopSurface: boolean, restart: boolean, shutdown: boolean }}
   */
  #features() {
    return {
      controls: true,
      questions: true,
      images: true,
      files: true,
      fileTree: true,
      sessionActions: true,
      balance: true,
      notifications: true,
      awake: true,
      displaySettings: true,
      desktopSurface: true,
      restart: describeRestart().supported,
      shutdown: describeShutdown().supported,
    };
  }

  /**
   * 读取当前登录账户的余额。
   *
   * 走宿主 `deepseekAccount` 服务：与桌面「设置 → 账户」用的是同一条
   * 平台查询，不在这里接触任何凭据。未登录、API Key 模式或查询失败时
   * 返回 `available: false`，首页据此隐藏余额卡片。
   *
   * @param {boolean} force - 绕过 60 秒缓存（用户点击刷新时）。
   * @returns {Promise<object>}
   */
  async #balance(force) {
    const service = this.ctx.get('deepseekAccount');
    if (service === undefined || typeof service.getBalance !== 'function' || typeof service.getState !== 'function') {
      return { ok: true, available: false, reason: 'unsupported' };
    }
    const cached = this.balanceCache.value;
    if (force !== true && cached !== undefined && Date.now() - this.balanceCache.at < BALANCE_CACHE_MS) {
      return cached;
    }
    if (this.balanceCache.pending !== undefined) return this.balanceCache.pending;

    const client = {
      version: ACCOUNT_CLIENT_VERSION,
      locale: 'zh-CN',
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
    };
    const request = (async () => {
      try {
        const state = await service.getState();
        if (state?.status !== 'credential-stored') {
          return { ok: true, available: false, reason: 'signed-out' };
        }
        const result = await service.getBalance(client);
        if (result === null) {
          // 凭据在查询过程中被移除/过期。
          return { ok: true, available: false, reason: 'signed-out' };
        }
        if (result?.status !== 'ready') {
          return { ok: true, available: false, reason: 'failed' };
        }
        return {
          ok: true,
          available: true,
          wallets: Array.isArray(result.value) ? result.value : [],
          bonusWallets: Array.isArray(result.bonusWallets) ? result.bonusWallets : [],
          fetchedAt: Date.now(),
        };
      } catch (error) {
        this.log(`pocket: balance read failed: ${error?.message ?? error}`);
        return { ok: true, available: false, reason: 'failed' };
      }
    })();
    this.balanceCache = { at: this.balanceCache.at, value: this.balanceCache.value, pending: request };
    try {
      const value = await request;
      this.balanceCache = { at: Date.now(), value, pending: undefined };
      return value;
    } catch (error) {
      this.balanceCache.pending = undefined;
      throw error;
    }
  }

  /**
   * 提供给桌面面板的状态。
   * @param {boolean} withToken
   * @returns {object}
   */
  status(withToken = false) {
    const urls = this.urls(withToken);
    let guiUrl;
    try {
      const connection = this.ctx.get('connection');
      const origin = this.ctx.get('webServer')?.getOrigin();
      if (connection !== undefined && typeof origin === 'string') {
        guiUrl = connection.authenticatedUrl(origin);
      }
    } catch {
      /* 没有 Web 连接能力时省略 */
    }
    const publicQr = withToken && typeof urls.publicUrl === 'string'
      ? { url: urls.publicUrl, image: qrDataUrl(urls.publicUrl, 240) }
      : null;
    const lanQr = withToken && typeof urls.lan[0] === 'string'
      ? { url: urls.lan[0], image: qrDataUrl(urls.lan[0], 240) }
      : null;
    const qr = withToken ? { public: publicQr, lan: lanQr } : undefined;
    return {
      ok: true,
      version: '0.17.0',
      startedAt: this.startedAt,
      lanSelected: urls.lanSelected,
      server: {
        listening: this.listening,
        port: this.port,
        host: this.bindHost,
        lan: this.config.lan,
        urls: {
          local: urls.local,
          lan: urls.lan,
          lanSelected: urls.lanSelected,
          lanOptions: urls.lanOptions,
          publicUrl: urls.publicUrl,
        },
      },
      tunnel: this.tunnel.snapshot(),
      awake: this.awake.status(),
      display: this.displaySettings(),
      surface: this.surface,
      mobileLayout: this.mobileLayout,
      desktopAvailable: this.gui.available() !== undefined,
      restart: describeRestart(),
      shutdown: describeShutdown(),
      guiUrl,
      features: this.#features(),
      qr,
      token: withToken ? this.token : undefined,
      tokenHint: withToken ? undefined : `${this.token.slice(0, 4)}…${this.token.slice(-4)}`,
    };
  }

  /**
   * 统一请求入口。
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async #handle(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    const method = req.method ?? 'GET';

    if (pathname === '/healthz') {
      sendJson(res, { ok: true, pocket: true, listening: this.listening });
      return;
    }

    // 跨站写请求拒绝：Origin 的 host 必须与 Host 一致。
    if (method !== 'GET' && method !== 'HEAD') {
      const origin = req.headers.origin;
      if (typeof origin === 'string' && origin.length > 0) {
        try {
          const originUrl = new URL(origin);
          if (originUrl.host !== req.headers.host) {
            sendJson(res, { ok: false, error: '跨站请求被拒绝' }, 403);
            return;
          }
        } catch {
          sendJson(res, { ok: false, error: '无效的 Origin' }, 403);
          return;
        }
      }
    }

    if (pathname === '/api/unlock' && method === 'POST') {
      await this.#unlock(req, res);
      return;
    }

    const authed = this.#isAuthed(req, url);

    // Pocket 自己的控制面（两种界面模式下都在）：查询/切换手机端界面。
    if (pathname === '/__pocket/surface') {
      await this.#surfaceControl(req, res, url);
      return;
    }

    // 手机上的目录选择器与新建工作区：桌面端原生的目录对话框在手机上看不到。
    if (pathname === '/__pocket/fs' && method === 'GET') {
      await this.#pocketFs(req, res, url);
      return;
    }
    if (pathname === '/__pocket/workspace' && method === 'POST') {
      await this.#pocketWorkspace(req, res, url);
      return;
    }
    // 手机端把工作区文件存到本地：轻量页与桌面直通共用同一个下载入口。
    if (pathname === '/__pocket/download' && (method === 'GET' || method === 'HEAD')) {
      await this.#pocketDownload(req, res, url);
      return;
    }

    // 桌面直通：整页反代宿主 Web GUI，插件 client bundle 一并复用。
    if (this.surface === 'desktop') {
      await this.#handleDesktop(req, res, url, authed);
      return;
    }

    if (pathname === '/' || pathname === '/index.html') {
      if (!authed) {
        sendHtml(res, UNLOCK_HTML, 401);
        return;
      }
      this.#setCookie(req, res);
      const html = await readAsset('index.html');
      if (html === undefined) {
        sendHtml(res, UNLOCK_HTML, 500);
        return;
      }
      sendHtml(res, html);
      return;
    }

    if (pathname === '/app.js' || pathname === '/app.css' || pathname === '/manifest.webmanifest') {
      const asset = await readAsset(pathname.slice(1));
      if (asset === undefined) {
        sendJson(res, { ok: false, error: '资源不存在' }, 404);
        return;
      }
      const ext = pathname.slice(pathname.lastIndexOf('.'));
      res.writeHead(200, {
        'Content-Type': MIME[ext] ?? 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'Content-Security-Policy': CSP,
      });
      res.end(asset);
      return;
    }

    if (pathname.startsWith('/icons/')) {
      const asset = await readAsset(pathname.slice(1));
      if (asset === undefined) {
        sendJson(res, { ok: false, error: '资源不存在' }, 404);
        return;
      }
      const ext = extname(pathname);
      res.writeHead(200, {
        'Content-Type': MIME[ext] ?? 'application/octet-stream',
        'Cache-Control': 'public, max-age=86400',
      });
      res.end(asset);
      return;
    }

    if (pathname === '/icon.svg' || pathname === '/favicon.svg') {
      try {
        const icon = await readFile(join(PACKAGE_ROOT, 'icon.svg'));
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
        res.end(icon);
      } catch {
        sendJson(res, { ok: false, error: '资源不存在' }, 404);
      }
      return;
    }

    if (!pathname.startsWith('/api/')) {
      sendJson(res, { ok: false, error: 'Not Found' }, 404);
      return;
    }

    if (!authed) {
      sendJson(res, { ok: false, error: '未授权', needsToken: true }, 401);
      return;
    }

    const parts = pathname.split('/').filter((segment) => segment.length > 0);
    // ['api', 'sessions', ...]
    try {
      if (pathname === '/api/status' && method === 'GET') {
        sendJson(res, this.status(false));
        return;
      }

      if (pathname === '/api/display' && method === 'GET') {
        sendJson(res, { ok: true, display: this.displaySettings() });
        return;
      }

      if (pathname === '/api/display' && method === 'POST') {
        const body = await readJson(req);
        sendJson(res, { ok: true, display: await this.setDisplay(body) });
        return;
      }

      if (pathname === '/api/keep-awake' && method === 'POST') {
        const body = await readJson(req);
        const awake = await this.setKeepAwake(body?.enabled === true);
        sendJson(res, { ok: true, awake });
        return;
      }

      // 一键重启整个 DSH：先调度辅助进程，再把响应发完；随后主进程会被结束并拉起。
      if (pathname === '/api/restart' && method === 'POST') {
        const restart = requestRestart();
        sendJson(res, { ok: true, restarting: true, restart });
        return;
      }

      // 一键关闭整个 DSH：与重启共用辅助进程，但退出后不再拉起。
      if (pathname === '/api/shutdown' && method === 'POST') {
        const shutdown = requestShutdown();
        sendJson(res, { ok: true, shuttingDown: true, shutdown });
        return;
      }

      if (pathname === '/api/balance' && method === 'GET') {
        sendJson(res, await this.#balance(url.searchParams.get('force') === '1'));
        return;
      }

      if (pathname === '/api/sessions' && method === 'GET') {
        sendJson(res, await this.#listSessions());
        return;
      }

      if (pathname === '/api/sessions' && method === 'POST') {
        const body = await readJson(req);
        const cwd = typeof body.cwd === 'string' && body.cwd.trim().length > 0 ? body.cwd.trim() : undefined;
        sendJson(res, { ok: true, ...(await this.#createSession(cwd)) });
        return;
      }

      if (pathname === '/api/workspace/files' && method === 'GET') {
        const root = this.#workspaceRoot(url.searchParams.get('root'));
        const listing = await this.#listDirectory(root, url.searchParams.get('path'));
        sendJson(res, { ok: true, ...listing });
        return;
      }

      if (pathname === '/api/workspace/text' && method === 'GET') {
        const root = this.#workspaceRoot(url.searchParams.get('root'));
        const preview = await this.#previewFile(root, url.searchParams.get('path'));
        sendJson(res, { ok: true, ...preview });
        return;
      }

      if (pathname === '/api/workspace/download' && (method === 'GET' || method === 'HEAD')) {
        const root = this.#workspaceRoot(url.searchParams.get('root'));
        await this.#sendDownload(res, root, url.searchParams.get('path'));
        return;
      }

      if (pathname === '/api/workspace/file' && method === 'GET') {
        const root = this.#workspaceRoot(url.searchParams.get('root'));
        await this.#sendImage(res, root, url.searchParams.get('path'));
        return;
      }

      if (parts[0] === 'api' && parts[1] === 'sessions' && typeof parts[2] === 'string') {
        const sessionId = parts[2];
        const action = parts[3];
        if (action === undefined) {
          sendJson(res, { ok: true, session: await this.#sessionMeta(sessionId) });
          return;
        }
        if (action === 'follow' && method === 'GET') {
          await this.#follow(req, res, sessionId);
          return;
        }
        if (action === 'page' && method === 'GET') {
          const before = url.searchParams.get('beforeSeq');
          const through = url.searchParams.get('throughSeq');
          const result = await this.#page(
            sessionId,
            before === null ? undefined : Number(before),
            through === null ? undefined : Number(through),
          );
          sendJson(res, { ok: true, ...result });
          return;
        }
        if (action === 'prompt' && method === 'POST') {
          const body = await readJson(req);
          const text = typeof body.text === 'string' ? body.text : '';
          const mode = body.mode === 'steer'
            ? 'steer'
            : body.mode === 'queue'
              ? 'queue'
              : 'auto';
          const images = Array.isArray(body.images) ? body.images : [];
          sendJson(res, { ok: true, ...(await this.#prompt(sessionId, text, mode, images)) });
          return;
        }
        if (action === 'cancel' && method === 'POST') {
          const result = await this.#cancel(sessionId);
          sendJson(res, { ok: true, ...result });
          return;
        }
        if (action === 'pin' && method === 'POST') {
          const body = await readJson(req);
          sendJson(res, { ok: true, ...(await this.#setPinned(sessionId, body.pinned !== false)) });
          return;
        }
        if (action === 'archive' && method === 'POST') {
          const body = await readJson(req);
          sendJson(res, { ok: true, ...(await this.#setArchived(sessionId, true, body.stopActivity === true)) });
          return;
        }
        if (action === 'unarchive' && method === 'POST') {
          sendJson(res, { ok: true, ...(await this.#setArchived(sessionId, false)) });
          return;
        }
        if (action === 'rename' && method === 'POST') {
          const body = await readJson(req);
          const title = typeof body.title === 'string' ? body.title.trim() : '';
          if (title.length === 0) {
            sendJson(res, { ok: false, error: '标题不能为空' }, 400);
            return;
          }
          sendJson(res, { ok: true, ...(await this.#renameSession(sessionId, title)) });
          return;
        }
        if (action === 'controls' && method === 'GET') {
          sendJson(res, { ok: true, ...(await this.#controls(sessionId)) });
          return;
        }
        if (action === 'model' && method === 'POST') {
          const body = await readJson(req);
          await this.#setModel(sessionId, body);
          sendJson(res, { ok: true });
          return;
        }
        if (action === 'permissions' && method === 'POST') {
          const body = await readJson(req);
          const state = await this.#setPermission(sessionId, body.preset);
          sendJson(res, { ok: true, ...state });
          return;
        }
        if (action === 'questions' && method === 'GET' && parts[4] === undefined) {
          sendJson(res, { ok: true, ...(await this.#questions(sessionId)) });
          return;
        }
        if (action === 'questions' && typeof parts[4] === 'string' && parts[5] === 'answer' && method === 'POST') {
          const body = await readJson(req);
          const result = await this.#answerQuestion(sessionId, parts[4], body.answers);
          sendJson(res, { ok: true, ...result });
          return;
        }
        if (action === 'interactions' && typeof parts[4] === 'string' && parts[5] === 'answer' && method === 'POST') {
          const body = await readJson(req);
          const accepted = this.#answerInteraction(sessionId, parts[4], body);
          if (!accepted) {
            sendJson(res, { ok: false, error: '这个提问已结束或不属于当前会话' }, 409);
            return;
          }
          sendJson(res, { ok: true });
          return;
        }
        if (action === 'file' && method === 'GET') {
          await this.#workspaceFile(res, sessionId, url.searchParams.get('path'));
          return;
        }
        if (action === 'download' && (method === 'GET' || method === 'HEAD')) {
          const cwd = await this.#sessionCwd(sessionId);
          await this.#sendDownload(res, cwd, url.searchParams.get('path'));
          return;
        }
        if (action === 'files' && method === 'GET') {
          const cwd = await this.#sessionCwd(sessionId);
          sendJson(res, { ok: true, ...(await this.#listDirectory(cwd, url.searchParams.get('path'))) });
          return;
        }
        if (action === 'text' && method === 'GET') {
          const cwd = await this.#sessionCwd(sessionId);
          sendJson(res, { ok: true, ...(await this.#previewFile(cwd, url.searchParams.get('path'))) });
          return;
        }
        if (action === 'attachments' && typeof parts[4] === 'string' && method === 'GET') {
          await this.#attachment(res, sessionId, parts[4], url.searchParams.get('download') === '1');
          return;
        }
      }

      sendJson(res, { ok: false, error: 'Not Found' }, 404);
    } catch (error) {
      const message = String(error?.message ?? error);
      this.log(`pocket: API ${pathname} failed: ${error?.stack ?? error}`);
      // Host 的 Remote 失败带稳定 code：会话仍在跑（409）时手机端可以引导“停止并归档”。
      const code = error?.isDSHRemoteError === true && typeof error.code === 'string' ? error.code : undefined;
      const status = Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode < 600
        ? error.statusCode
        : error?.statusCode === 413
        ? 413
        : code === 'workspace/session-active'
        ? 409
        : code === 'session/not-found' || code === 'workspace/not-found'
          ? 404
          : code === 'session/title-invalid' || code === 'gateway/bad-request'
            ? 400
            : 500;
      sendJson(res, {
        ok: false,
        error: message,
        ...(code === undefined ? {} : { code }),
        ...(code === 'workspace/session-active' ? { activity: error.details?.activity ?? [] } : {}),
      }, status);
    }
  }

  /**
   * 手机端界面模式控制。
   *
   * GET 不带 `to` 时返回当前模式；`GET ?to=mobile|desktop` 切完直接 303 回首页，
   * 供没有前端脚本的兜底页使用；POST 接受 JSON 或表单。
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} url
   * @returns {Promise<void>}
   */
  async #surfaceControl(req, res, url) {
    if (!this.#isAuthed(req, url)) {
      sendJson(res, { ok: false, error: '未授权', needsToken: true }, 401);
      return;
    }
    try {
      if (req.method === 'GET') {
        const to = url.searchParams.get('to');
        if (to === 'desktop' || to === 'mobile') {
          await this.setSurface(to);
          res.writeHead(303, { Location: '/', 'Cache-Control': 'no-store' });
          res.end();
          return;
        }
        sendJson(res, {
          ok: true,
          surface: this.surface,
          desktopAvailable: this.gui.available() !== undefined,
        });
        return;
      }
      if (req.method === 'POST') {
        const contentType = String(req.headers['content-type'] ?? '');
        let body;
        if (contentType.includes('application/json')) {
          body = await readJson(req);
        } else {
          const raw = await readBody(req, 4096);
          body = Object.fromEntries(new URLSearchParams(raw));
        }
        const mode = body?.surface ?? body?.mode;
        if (mode !== 'desktop' && mode !== 'mobile') {
          sendJson(res, { ok: false, error: 'surface 只能是 mobile 或 desktop' }, 400);
          return;
        }
        sendJson(res, { ok: true, surface: await this.setSurface(mode) });
        return;
      }
      sendJson(res, { ok: false, error: '只支持 GET 与 POST' }, 405);
    } catch (error) {
      this.log(`pocket: surface switch failed: ${error?.stack ?? error}`);
      sendJson(res, { ok: false, error: String(error?.message ?? error) }, 400);
    }
  }

  /**
   * 手机端目录选择器：列出本机某个目录下的子目录。
   *
   * 桌面端的「添加工作区」会调起电脑上的原生目录对话框，手机上是不可见的；
   * 这里给手机一个自己的浏览接口。只返回目录名，不读文件内容；默认从用户主
   * 目录开始，也可以直接传绝对路径。
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} url
   * @returns {Promise<void>}
   */
  async #pocketFs(req, res, url) {
    if (!this.#isAuthed(req, url)) {
      sendJson(res, { ok: false, error: '未授权', needsToken: true }, 401);
      return;
    }
    const raw = (url.searchParams.get('path') ?? '').trim();
    const target = resolve(raw.length > 0 ? raw : homedir());
    try {
      const info = await stat(target);
      if (!info.isDirectory()) throw new Error('不是目录');
    } catch {
      sendJson(res, { ok: false, error: `无法读取目录：${target}` }, 400);
      return;
    }
    let entries;
    try {
      entries = await readdir(target, { withFileTypes: true });
    } catch {
      sendJson(res, { ok: false, error: `没有权限读取：${target}` }, 403);
      return;
    }
    const dirs = entries
      .filter((entry) => entry.isDirectory())
      .slice(0, 500)
      .map((entry) => ({ name: entry.name, path: join(target, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
    const parent = dirname(target);
    sendJson(res, {
      ok: true,
      path: target,
      parent: parent === target ? null : parent,
      home: homedir(),
      entries: dirs,
    });
  }

  /**
   * 手机端新建工作区：验证目录后走宿主的 `workspaceRegistry.create`。
   * 与桌面端「添加工作区」落库的是同一种工作区。
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} url
   * @returns {Promise<void>}
   */
  async #pocketWorkspace(req, res, url) {
    if (!this.#isAuthed(req, url)) {
      sendJson(res, { ok: false, error: '未授权', needsToken: true }, 401);
      return;
    }
    try {
      const body = await readJson(req);
      const raw = typeof body?.path === 'string' ? body.path.trim() : '';
      if (raw.length === 0) {
        sendJson(res, { ok: false, error: '请填写目录路径' }, 400);
        return;
      }
      const target = resolve(raw);
      let info;
      try {
        info = await stat(target);
      } catch {
        sendJson(res, { ok: false, error: `目录不存在：${target}` }, 400);
        return;
      }
      if (!info.isDirectory()) {
        sendJson(res, { ok: false, error: `不是目录：${target}` }, 400);
        return;
      }
      const registry = this.ctx.get('workspaceRegistry');
      if (registry === undefined || typeof registry.create !== 'function') {
        sendJson(res, { ok: false, error: '当前组合不支持新建工作区（缺少 workspaceRegistry）' }, 501);
        return;
      }
      const workspace = await registry.create(target);
      sendJson(res, {
        ok: true,
        path: target,
        id: workspace?.workspaceId ?? workspace?.id ?? null,
        title: workspace?.title ?? null,
      });
    } catch (error) {
      this.log(`pocket: add workspace failed: ${error?.stack ?? error}`);
      sendJson(res, { ok: false, error: String(error?.message ?? error) }, 500);
    }
  }

  /**
   * 手机端文件下载：用会话 cwd 做根，只允许读取该目录子树。
   *
   * 桌面直通页面里的下载按钮走这里：GUI 自己的文档预览只渲染、不提供
   * 浏览器下载路由；Pocket 用会话 id + 相对路径把原始文件流给手机。
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} url
   * @returns {Promise<void>}
   */
  async #pocketDownload(req, res, url) {
    if (!this.#isAuthed(req, url)) {
      sendJson(res, { ok: false, error: '未授权', needsToken: true }, 401);
      return;
    }
    try {
      const sessionId = url.searchParams.get('session');
      if (typeof sessionId !== 'string' || sessionId.trim().length === 0) throw httpError('缺少 session', 400);
      const cwd = await this.#sessionCwd(sessionId);
      await this.#sendDownload(res, cwd, url.searchParams.get('path'));
    } catch (error) {
      this.log(`pocket: download failed: ${error?.stack ?? error}`);
      if (!res.headersSent) {
        const status = Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode < 600
          ? error.statusCode
          : 500;
        sendJson(res, { ok: false, error: String(error?.message ?? error) }, status);
      } else {
        res.destroy();
      }
    }
  }

  /**
   * 桌面直通模式下的整页反代。
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} url
   * @param {boolean} authed
   * @returns {Promise<void>}
   */
  async #handleDesktop(req, res, url, authed) {
    const pathname = decodeURIComponent(url.pathname);
    if (!authed) {
      if (pathname === '/' || pathname === '/index.html') sendHtml(res, UNLOCK_HTML, 401);
      else sendJson(res, { ok: false, error: '未授权', needsToken: true }, 401);
      return;
    }
    if (pathname === '/' || pathname === '/index.html') this.#setCookie(req, res);
    try {
      await this.gui.handleHttp(req, res);
    } catch (error) {
      this.log(`pocket: desktop proxy failed: ${error?.stack ?? error}`);
      if (!res.headersSent) sendHtml(res, PROXY_FAIL_HTML, 502);
      else res.end();
    }
  }

  /**
   * 判断请求是否携带有效令牌。
   * @param {import('node:http').IncomingMessage} req
   * @param {URL} url
   * @returns {boolean}
   */
  #isAuthed(req, url) {
    const fromQuery = url.searchParams.get('token');
    if (fromQuery !== null && tokenEquals(fromQuery, this.token)) return true;
    const fromHeader = req.headers['x-pocket-token'];
    if (typeof fromHeader === 'string' && tokenEquals(fromHeader, this.token)) return true;
    const auth = req.headers.authorization;
    if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
      if (tokenEquals(auth.slice(7).trim(), this.token)) return true;
    }
    const fromCookie = readCookie(req.headers.cookie, COOKIE_NAME);
    return tokenEquals(fromCookie, this.token);
  }

  /**
   * 首次带 token 访问时种下 Cookie。
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  #setCookie(req, res) {
    const forwarded = req.headers['x-forwarded-proto'];
    const secure = req.socket?.encrypted === true || forwarded === 'https';
    res.setHeader(
      'Set-Cookie',
      `${COOKIE_NAME}=${this.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure ? '; Secure' : ''}`,
    );
  }

  /**
   * 表单解锁。
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async #unlock(req, res) {
    let token = '';
    try {
      const body = await readBody(req, 4096);
      const params = new URLSearchParams(body);
      token = params.get('token') ?? '';
    } catch {
      /* 按失败处理 */
    }
    if (!tokenEquals(token.trim(), this.token)) {
      sendHtml(res, UNLOCK_HTML.replace('输入桌面端', '令牌不正确，输入桌面端'), 401);
      return;
    }
    this.#setCookie(req, res);
    res.writeHead(303, { Location: '/', 'Cache-Control': 'no-store' });
    res.end();
  }

  /**
   * 取会话控制器。
   * @returns {any}
   */
  #controller() {
    const controller = this.ctx.get('sessionController');
    if (controller === undefined) throw new Error('sessionController 不可用（需要 Web 版 DSH）');
    return controller;
  }

  /**
   * 解析或恢复一个会话的 live Agent。
   * @param {string} sessionId
   * @returns {Promise<any>}
   */
  async #resolveAgent(sessionId) {
    const controller = this.#controller();
    const result = await controller.resolveAgent(sessionId);
    if (result?.agent !== undefined) return result.agent;
    const error = result?.error;
    throw new Error(error?.message ?? String(error ?? '无法恢复会话'));
  }

  /**
   * 读取桌面设置里的「繁忙时的发送行为」。
   * 该值由 ui-conversation 的 config form 持久化到 profile patch。
   * @returns {'queue' | 'steer'}
   */
  #busyEnter() {
    const settings = this.ctx.get('settings');
    if (settings === undefined) return 'queue';
    try {
      const entries = settings.describe({ redactSecrets: true });
      const entry = entries.find((item) => item?.value !== null && typeof item?.value === 'object' && 'busyEnter' in item.value)
        ?? entries.find((item) => item?.ns === 'ui-conversation');
      return entry?.value?.busyEnter === 'steer' ? 'steer' : 'queue';
    } catch {
      return 'queue';
    }
  }

  /**
   * 汇总手机端会话设置：模型目录/当前选择、权限目录/当前预设、可见技能。
   * 单项失败只记入 errors，不拖垮整个面板。
   * @param {string} sessionId
   * @returns {Promise<object>}
   */
  async #controls(sessionId) {
    const controller = this.#controller();
    const errors = [];
    const [catalogResult, projectionResult, permissionsResult, skillsResult] = await Promise.allSettled([
      controller.modelCatalog(),
      controller.projections({ sessionId }, new AbortController().signal),
      this.#permissionControls(sessionId),
      this.#sessionSkills(sessionId),
    ]);
    const settle = (result, fallback, label) => {
      if (result.status === 'fulfilled') return result.value;
      errors.push(`${label}: ${String(result.reason?.message ?? result.reason)}`);
      return fallback;
    };
    const catalog = settle(catalogResult, undefined, '模型目录');
    const projections = settle(projectionResult, undefined, '会话投影');
    const permissions = settle(permissionsResult, undefined, '权限');
    const skills = settle(skillsResult, [], '技能');
    const values = projections?.kind === 'sequenced' ? projections.values : projections?.values;
    const modelSelection = values?.modelSelection;
    return {
      model: {
        catalog,
        selection: modelSelection?.next ?? modelSelection?.lastUsed ?? catalog?.default,
      },
      permissions,
      skills,
      busyEnter: this.#busyEnter(),
      errors,
    };
  }

  /**
   * @param {string} sessionId
   * @returns {Promise<{ catalog: any, current: string | null } | undefined>}
   */
  async #permissionControls(sessionId) {
    const presets = this.ctx.get('permissionPresets');
    if (presets === undefined) return undefined;
    const catalog = presets.catalog();
    const agent = this.ctx.get('agents')?.get(sessionId);
    return {
      catalog,
      current: agent === undefined ? null : presets.current(agent.session),
    };
  }

  /**
   * @param {string} sessionId
   * @returns {Promise<object[]>}
   */
  async #sessionSkills(sessionId) {
    const catalog = this.ctx.get('sessionSkillCatalog');
    if (catalog === undefined) return [];
    const value = await catalog.list({ sessionId }, new AbortController().signal);
    return Array.isArray(value?.skills) ? value.skills : [];
  }

  /**
   * @param {string} sessionId
   * @param {any} body
   */
  async #setModel(sessionId, body) {
    const provider = typeof body?.provider === 'string' ? body.provider.trim() : '';
    const model = typeof body?.model === 'string' ? body.model.trim() : '';
    if (provider.length === 0 || model.length === 0) throw new Error('缺少 provider 或 model');
    const reasoningEffort = typeof body?.reasoningEffort === 'string' && body.reasoningEffort.trim().length > 0
      ? body.reasoningEffort.trim()
      : undefined;
    const controller = this.#controller();
    await controller.selectModel({
      sessionId,
      provider,
      model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    });
  }

  /**
   * @param {string} sessionId
   * @param {unknown} preset
   * @returns {Promise<{ current: string }>}
   */
  async #setPermission(sessionId, preset) {
    const name = typeof preset === 'string' ? preset.trim() : '';
    if (name.length === 0) throw new Error('缺少权限预设');
    const presets = this.ctx.get('permissionPresets');
    if (presets === undefined) throw new Error('permissionPresets 不可用');
    const agent = await this.#resolveAgent(sessionId);
    presets.set(agent.session, name);
    return { current: presets.current(agent.session) };
  }

  /**
   * @param {string} sessionId
   * @returns {Promise<{ active: object[], settled: object[] }>}
   */
  async #questions(sessionId) {
    const controller = this.#controller();
    const result = await controller.projections({ sessionId }, new AbortController().signal);
    const values = result?.kind === 'sequenced' ? result.values : result?.values;
    const questions = values?.userQuestions;
    return {
      active: Array.isArray(questions?.active) ? questions.active : [],
      settled: Array.isArray(questions?.settled) ? questions.settled : [],
    };
  }

  /**
   * @param {string} sessionId
   * @param {string} callId
   * @param {unknown} answers
   * @returns {Promise<{ accepted: boolean }>}
   */
  async #answerQuestion(sessionId, callId, answers) {
    if (!Array.isArray(answers)) throw new Error('answers 必须是数组');
    const normalized = answers.map((answer) => ({
      id: String(answer?.id ?? ''),
      selected: Array.isArray(answer?.selected) ? answer.selected.map(String) : [],
      ...(typeof answer?.custom === 'string' && answer.custom.length > 0 ? { custom: answer.custom } : {}),
    }));
    const service = this.ctx.get('userQuestions');
    if (service === undefined) throw new Error('userQuestions 不可用');
    const agent = await this.#resolveAgent(sessionId);
    const accepted = service.answer(agent, callId, { answers: normalized });
    return { accepted: accepted === true };
  }

  /**
   * 会话列表 + 标题。
   * @returns {Promise<object[]>}
   */
  async #listSessions() {
    const controller = this.#controller();
    const { items } = await controller.list({}, new AbortController().signal);
    const visible = items.filter((item) => item.origin !== 'subagent');
    const query = this.ctx.get('sessionQuery');
    const ids = visible.map((item) => item.sessionId);
    const now = Date.now();
    /** @type {Map<string, { title?: string, cwd?: string, at: number }>} */
    const titles = this.titleCache;
    for (const id of titles.keys()) {
      if (!ids.includes(id)) titles.delete(id);
    }
    // session-title 注册了 `title` projection；列表行自带缓存值时直接用，
    // 只有拿不到 projection 的会话才去折日志。
    for (const item of visible) {
      const projected = item.projections?.values?.title;
      if (typeof projected === 'string' && projected.length > 0) {
        titles.set(item.sessionId, {
          title: projected,
          cwd: typeof item.cwd === 'string' ? item.cwd : undefined,
          at: now,
        });
      }
    }
    const missing = ids.filter((id) => {
      const entry = titles.get(id);
      if (entry === undefined) return true;
      if (entry.title !== undefined) return false;
      return now - entry.at > 300_000;
    });
    if (query !== undefined && missing.length > 0) {
      try {
        const snapshots = await query.readTitleSnapshots(missing);
        for (const result of snapshots) {
          if (result.status !== 'fulfilled') continue;
          titles.set(result.sessionId, {
            title: result.value.title?.title,
            cwd: result.value.session.cwd,
            at: now,
          });
        }
      } catch (error) {
        this.log(`pocket: readTitleSnapshots failed: ${error?.message ?? error}`);
      }
    }
    const rows = visible.map((item) => {
      const meta = titles.get(item.sessionId);
      const cwd = typeof item.cwd === 'string' ? item.cwd : meta?.cwd;
      const fallback = cwd === undefined ? '会话' : (cwd.split(/[\\/]/u).filter(Boolean).pop() ?? '会话');
      return {
        id: item.sessionId,
        title: meta?.title ?? (item.blank === true ? '新会话' : fallback),
        cwd: cwd ?? '',
        running: item.running === true,
        blank: item.blank === true,
        agentAvailable: item.agentAvailable === true,
        origin: item.origin,
        parentSessionId: item.parentSessionId,
        updatedAt: item.updatedAt,
        updatedAtIso: isoTime(item.updatedAt),
      };
    });

    const frame = await this.#workspaceSnapshot();
    if (frame === undefined) {
      // 没有 workspace 服务的组合：按 cwd 粗略分组，至少保留工作区形式。
      const groups = new Map();
      for (const row of rows) {
        const key = row.cwd || '';
        const title = key.length === 0 ? '未分组' : (key.split(/[\\/]/u).filter(Boolean).pop() ?? key);
        const group = groups.get(key) ?? { id: key, title, path: key, sessions: [] };
        group.sessions.push(row);
        groups.set(key, group);
      }
      const workspaces = [...groups.values()];
      this.#rememberWorkspaceRoots(workspaces);
      return {
        ok: true,
        features: this.#features(),
        awake: this.awake.status(),
        display: this.displaySettings(),
        items: rows,
        workspaces,
        unassigned: [],
        archived: [],
        pinned: [],
        pending: this.#pendingSummaries(),
        counts: { total: rows.length, workspaces: workspaces.length, archived: 0 },
      };
    }

    const archivedSet = new Set(frame.archivedSessionIds ?? []);
    const pinnedSet = new Set(frame.pinnedSessionIds ?? []);
    const rowById = new Map(rows.map((row) => [row.id, row]));
    const decorate = (row) => ({
      ...row,
      archived: archivedSet.has(row.id),
      pinned: pinnedSet.has(row.id),
    });
    /**
     * 空会话（点过“新建会话”但没发消息）没有可读内容，手机列表完全不显示。
     * 它们仍保留在 DSH 里，桌面端和归档视图不受影响。
     * @param {any[]} sessions
     * @returns {any[]}
     */
    const withoutBlank = (sessions) => sessions.filter((row) => row.blank !== true);

    const assignedIds = new Set();
    const workspaces = (frame.items ?? []).map((workspace) => {
      const sessionIds = workspace.sessionIds ?? [];
      for (const id of sessionIds) assignedIds.add(id);
      const sessions = withoutBlank(
        sessionIds
          .map((id) => rowById.get(id))
          .filter((row) => row !== undefined && !archivedSet.has(row.id))
          .map(decorate),
      );
      return {
        id: workspace.workspaceId,
        title: workspace.title === 'default-workspace' ? '默认工作区' : workspace.title,
        path: workspace.path,
        sessions,
      };
    });

    const unassigned = withoutBlank(
      rows
        .filter((row) => !assignedIds.has(row.id) && !archivedSet.has(row.id))
        .map(decorate),
    );
    const archived = withoutBlank(rows.filter((row) => archivedSet.has(row.id)).map(decorate));
    const pinned = withoutBlank(
      rows
        .filter((row) => pinnedSet.has(row.id) && !archivedSet.has(row.id))
        .map(decorate),
    );
    const visibleCount = workspaces.reduce((sum, workspace) => sum + workspace.sessions.length, 0) + unassigned.length;
    const hiddenBlank = rows.filter((row) => row.blank === true && !archivedSet.has(row.id)).length;
    this.#rememberWorkspaceRoots(workspaces);

    return {
      ok: true,
      features: this.#features(),
      awake: this.awake.status(),
      display: this.displaySettings(),
      items: rows.map(decorate),
      workspaces,
      unassigned,
      archived,
      pinned,
      pending: this.#pendingSummaries(),
      counts: {
        total: rows.length,
        workspaces: workspaces.length,
        archived: archived.length,
        visible: visibleCount,
        hiddenBlank,
      },
    };
  }

  /**
   * 记录当前列表里的工作区根目录；首页文件树只接受这些路径。
   * @param {{ path?: string }[]} workspaces
   */
  #rememberWorkspaceRoots(workspaces) {
    const roots = new Set();
    for (const workspace of workspaces) {
      if (typeof workspace.path !== 'string' || workspace.path.length === 0) continue;
      roots.add(rootKey(workspace.path));
    }
    this.workspaceRoots = roots;
  }

  /**
   * 读取一次 workspace 基线，用来复刻桌面侧栏的工作区分组、归档与置顶。
   * 失败或超时时返回 undefined，调用方回退到按 cwd 分组。
   * @returns {Promise<any | undefined>}
   */
  async #workspaceSnapshot() {
    const controller = this.ctx.get('workspaceController');
    if (controller === undefined) return undefined;
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 5_000);
    timeout.unref?.();
    let iterator;
    try {
      iterator = controller.follow(abort.signal)[Symbol.asyncIterator]();
      const first = await iterator.next();
      if (first.done) return undefined;
      const frame = first.value;
      return frame?.type === 'baseline' ? frame.value : undefined;
    } catch (error) {
      this.log(`pocket: workspace baseline failed: ${error?.message ?? error}`);
      return undefined;
    } finally {
      clearTimeout(timeout);
      abort.abort();
      try {
        await iterator?.return?.();
      } catch {
        /* generator 已被 abort */
      }
    }
  }

  /**
   * 会话元信息（标题/目录/运行状态），用于打开聊天页时的 hello 帧。
   * @param {string} sessionId
   * @returns {Promise<object>}
   */
  async #sessionMeta(sessionId) {
    const query = this.ctx.get('sessionQuery');
    const cached = this.titleCache.get(sessionId);
    let title = cached?.title;
    let cwd = cached?.cwd;
    if (query !== undefined && (title === undefined || cwd === undefined)) {
      try {
        const observation = await query.readTitleSnapshot(sessionId);
        title = title ?? observation.title?.title;
        cwd = cwd ?? observation.session.cwd;
        this.titleCache.set(sessionId, { title, cwd, at: Date.now() });
      } catch {
        /* 冷会话读不到标题时忽略 */
      }
    }
    const agent = this.ctx.get('agents')?.get(sessionId);
    return {
      sessionId,
      title: title ?? '会话',
      cwd: cwd ?? '',
      running: agent?.status === 'running',
    };
  }

  /**
   * 新建会话。
   * @param {string | undefined} cwd
   * @returns {Promise<{ sessionId: string }>}
   */
  async #createSession(cwd) {
    const controller = this.#controller();
    const result = await controller.create(cwd === undefined ? {} : { cwd });
    // 与桌面端一致：新会话落进对应的 Workspace，而不是只留在“未分组”。
    if (cwd !== undefined) {
      const registry = this.ctx.get('workspaceRegistry');
      if (registry !== undefined) {
        try {
          const workspace = await registry.create(cwd);
          await workspace.attachSession(result.sessionId);
        } catch (error) {
          this.log(`pocket: attach workspace failed: ${error?.message ?? error}`);
        }
      }
    }
    return { sessionId: result.sessionId };
  }

  /**
   * 读一页历史。
   * @param {string} sessionId
   * @param {number | undefined} beforeSeq
   * @param {number | undefined} throughSeq
   * @returns {Promise<object>}
   */
  async #page(sessionId, beforeSeq, throughSeq) {
    const controller = this.#controller();
    const result = await controller.page({
      address: { kind: 'session', sessionId },
      throughSeq: Number.isInteger(throughSeq) ? throughSeq : -1,
      beforeSeq: Number.isInteger(beforeSeq) ? beforeSeq : undefined,
      maxMessages: FOLLOW_MAX_MESSAGES,
      turnWindow: { minMessages: 20, minTurns: 2 },
    }, new AbortController().signal);
    const records = [];
    for (const record of result.records ?? []) {
      if (record?.type !== 'event') continue;
      const event = compactEvent(record.event, this.display);
      if (event !== undefined) records.push({ type: 'event', event });
    }
    return { records, hasMore: result.hasMore === true };
  }

  /**
   * 发送提示词。
   * @param {string} sessionId
   * @param {string} text
   * @param {'queue' | 'steer' | 'auto'} mode
   * @returns {Promise<{ requestId: string }>}
   */
  async #prompt(sessionId, text, mode, images = []) {
    const cleanText = typeof text === 'string' ? text : '';
    if (cleanText.trim().length === 0 && images.length === 0) throw new Error('消息不能为空');
    if (cleanText.length > 100_000) throw new Error('消息过长');
    const content = [];
    if (cleanText.trim().length > 0) content.push({ type: 'text', text: cleanText });
    let imageCount = 0;
    let imageChars = 0;
    for (const image of images) {
      if (imageCount >= 4) break;
      if (image === null || typeof image !== 'object') continue;
      const mediaType = String(image.mediaType ?? '');
      if (!/^image\/(?:png|jpe?g|webp|gif)$/u.test(mediaType)) {
        throw new Error('只支持 png/jpeg/webp/gif 图片');
      }
      const data = String(image.data ?? '').replace(/^data:image\/[^;]+;base64,/u, '');
      if (data.length === 0) continue;
      if (data.length > 8_000_000) throw new Error('单张图片不能超过 6 MB');
      imageChars += data.length;
      if (imageChars > 20_000_000) throw new Error('图片总大小不能超过 15 MB');
      const name = typeof image.name === 'string' && image.name.trim().length > 0 ? image.name.trim() : undefined;
      content.push({
        type: 'image',
        mediaType,
        data,
        ...(name === undefined ? {} : { name }),
      });
      imageCount += 1;
    }
    if (content.length === 0) throw new Error('消息不能为空');
    const controller = this.#controller();
    const running = this.ctx.get('agents')?.get(sessionId)?.status === 'running';
    const effectiveMode = mode === 'auto' ? (running ? this.#busyEnter() : 'queue') : mode;
    const requestId = randomUUID();
    await controller.prompt({
      requestId,
      sessionId,
      mode: effectiveMode,
      content,
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }, new AbortController().signal);
    return { requestId, mode: effectiveMode };
  }

  /**
   * 取消当前回合。
   * @param {string} sessionId
   * @returns {Promise<object>}
   */
  async #cancel(sessionId) {
    const controller = this.#controller();
    return controller.cancel({ sessionId });
  }

  /**
   * 取工作区控制器（置顶、归档、取消归档）。
   * @returns {any}
   */
  #workspace() {
    const controller = this.ctx.get('workspaceController');
    if (controller === undefined) throw new Error('workspaceController 不可用（需要 Web 版 DSH）');
    return controller;
  }

  /**
   * 置顶 / 取消置顶会话。置顶集合由注册表全局持有，Pocket 只在会话所属工作区内排到最前。
   * @param {string} sessionId
   * @param {boolean} pinned
   * @returns {Promise<{ pinned: boolean, pinnedSessionIds: string[] }>}
   */
  async #setPinned(sessionId, pinned) {
    const controller = this.#workspace();
    const result = pinned
      ? await controller.pinSession({ sessionId })
      : await controller.unpinSession({ sessionId });
    return {
      pinned,
      pinnedSessionIds: Array.isArray(result?.pinnedSessionIds) ? result.pinnedSessionIds : [],
    };
  }

  /**
   * 归档 / 取消归档会话。
   * 不带 `stopActivity` 时，Host 会拒绝仍有工作在跑的会话。
   * @param {string} sessionId
   * @param {boolean} archived
   * @param {boolean} [stopActivity] 归档前先停止仍在跑的工作
   * @returns {Promise<{ archived: boolean, archivedSessionIds: string[] }>}
   */
  async #setArchived(sessionId, archived, stopActivity = false) {
    const controller = this.#workspace();
    const result = archived
      ? await controller.archiveSession({ sessionId, ...(stopActivity ? { stopActivity: true } : {}) })
      : await controller.unarchiveSession({ sessionId });
    return {
      archived,
      archivedSessionIds: Array.isArray(result?.archivedSessionIds) ? result.archivedSessionIds : [],
    };
  }

  /**
   * 重命名会话。成功后就地更新标题缓存，列表下一次轮询即可看到新标题。
   * @param {string} sessionId
   * @param {unknown} title
   * @returns {Promise<{ title: string }>}
   */
  async #renameSession(sessionId, title) {
    const value = typeof title === 'string' ? title.trim() : '';
    if (value.length === 0) throw new Error('标题不能为空');
    if (value.length > 200) throw new Error('标题不能超过 200 个字符');
    const controller = this.#controller();
    const result = await controller.rename({ sessionId, title: value });
    const accepted = typeof result?.title === 'string' && result.title.length > 0 ? result.title : value;
    const cached = this.titleCache.get(sessionId);
    this.titleCache.set(sessionId, { ...(cached ?? {}), title: accepted, at: Date.now() });
    return { title: accepted };
  }

  /**
   * 读取会话的工作目录（在线 Agent 优先，冷会话回退到日志快照）。
   * @param {string} sessionId
   * @returns {Promise<string>}
   */
  async #sessionCwd(sessionId) {
    const query = this.ctx.get('sessionQuery');
    let cwd = this.ctx.get('sessions')?.get(sessionId)?.header.cwd;
    if (cwd === undefined && query !== undefined) {
      try {
        const observation = await query.readTitleSnapshot(sessionId);
        cwd = observation?.session?.cwd;
      } catch {
        /* 冷会话读不到目录 */
      }
    }
    if (typeof cwd !== 'string' || cwd.length === 0) throw httpError('会话没有工作目录', 404);
    return cwd;
  }

  /**
   * 首页文件树只允许浏览已登记的工作区根目录，避免变成任意文件读取器。
   * @param {string | null} rawRoot
   * @returns {string}
   */
  #workspaceRoot(rawRoot) {
    if (typeof rawRoot !== 'string' || rawRoot.trim().length === 0) throw httpError('缺少工作区路径', 400);
    const root = resolve(rawRoot.trim());
    if (!this.workspaceRoots.has(rootKey(root))) {
      throw httpError('只能浏览已登记的工作区', 403);
    }
    return root;
  }

  /**
   * 把用户给的相对路径解析到工作区内，并用 realpath 再校验一次符号链接。
   * @param {string} root
   * @param {string | null} rawPath
   * @returns {Promise<{ root: string, realRoot: string, target: string, realTarget: string, path: string }>}
   */
  async #resolveRooted(root, rawPath) {
    const rootPath = resolve(root);
    const value = typeof rawPath === 'string' ? rawPath.trim() : '';
    const target = resolve(rootPath, value);
    if (!insideRoot(target, rootPath)) throw httpError('只能读取工作区内的文件', 403);
    let realRoot;
    let realTarget;
    try {
      [realRoot, realTarget] = await Promise.all([realpath(rootPath), realpath(target)]);
    } catch {
      throw httpError('文件不存在', 404);
    }
    if (!insideRoot(realTarget, realRoot)) throw httpError('只能读取工作区内的文件', 403);
    return {
      root: rootPath,
      realRoot,
      target,
      realTarget,
      path: relativePath(rootPath, target),
    };
  }

  /**
   * 列出工作区里的一层目录。
   * @param {string} root
   * @param {string | null} rawPath
   * @returns {Promise<{ root: string, path: string, entries: object[], truncated: boolean }>}
   */
  async #listDirectory(root, rawPath) {
    const { root: rootPath, realRoot, realTarget, path } = await this.#resolveRooted(root, rawPath);
    let info;
    try {
      info = await stat(realTarget);
    } catch {
      throw httpError('文件不存在', 404);
    }
    if (!info.isDirectory()) throw httpError('不是目录', 400);

    let dirents;
    try {
      dirents = await readdir(realTarget, { withFileTypes: true });
    } catch {
      throw httpError('无法读取目录', 500);
    }
    const truncated = dirents.length > FILE_LIST_LIMIT;
    if (truncated) dirents = dirents.slice(0, FILE_LIST_LIMIT);

    const entries = (await Promise.all(dirents.map(async (dirent) => {
      const childAbs = join(realTarget, dirent.name);
      let childInfo;
      try {
        if (dirent.isSymbolicLink()) {
          const childReal = await realpath(childAbs);
          if (!insideRoot(childReal, realRoot)) return undefined;
          childInfo = await stat(childReal);
        } else {
          childInfo = await stat(childAbs);
        }
      } catch {
        return undefined;
      }
      const kind = childInfo.isDirectory() ? 'dir' : childInfo.isFile() ? 'file' : undefined;
      if (kind === undefined) return undefined;
      const childPath = path.length === 0 ? dirent.name : `${path}/${dirent.name}`;
      const extension = extname(dirent.name).toLowerCase();
      return {
        name: dirent.name,
        path: childPath,
        kind,
        size: kind === 'file' ? childInfo.size : 0,
        mtime: Number(childInfo.mtimeMs ?? 0),
        text: kind === 'file' && textCandidate(dirent.name),
        image: kind === 'file' && IMAGE_MIME[extension] !== undefined,
      };
    }))).filter((entry) => entry !== undefined);

    entries.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'dir' ? -1 : 1;
      return left.name.localeCompare(right.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
    });
    return { root: rootPath, path, entries, truncated };
  }

  /**
   * 读取文本预览；图片单独标记，二进制文件不返回内容。
   * @param {string} root
   * @param {string | null} rawPath
   * @returns {Promise<object>}
   */
  async #previewFile(root, rawPath) {
    const { realTarget, path } = await this.#resolveRooted(root, rawPath);
    if (path.length === 0) throw httpError('请选择一个文件', 400);
    let info;
    try {
      info = await stat(realTarget);
    } catch {
      throw httpError('文件不存在', 404);
    }
    if (!info.isFile()) throw httpError('不是一个文件', 400);
    const extension = extname(realTarget).toLowerCase();
    const base = { path, size: info.size, mtime: Number(info.mtimeMs ?? 0) };
    const imageType = IMAGE_MIME[extension];
    if (imageType !== undefined) {
      return { ...base, text: false, image: true, binary: false, mime: imageType };
    }
    if (BINARY_EXT.has(extension)) return { ...base, text: false, image: false, binary: true };

    const length = Math.min(info.size, TEXT_PREVIEW_LIMIT);
    let buffer = Buffer.alloc(length);
    if (length > 0) {
      let handle;
      try {
        handle = await open(realTarget, 'r');
        const result = await handle.read(buffer, 0, length, 0);
        buffer = buffer.subarray(0, result.bytesRead);
      } catch {
        throw httpError('读取文件失败', 500);
      } finally {
        if (handle !== undefined) await handle.close().catch(() => {});
      }
    }
    // 没有扩展名的二进制（例如可执行文件）用 NUL 字节兜底识别。
    if (buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0)) {
      return { ...base, text: false, image: false, binary: true };
    }
    let content = buffer.toString('utf8');
    if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
    return {
      ...base,
      text: true,
      image: false,
      binary: false,
      truncated: info.size > TEXT_PREVIEW_LIMIT,
      content,
    };
  }

  /**
   * 输出工作区里的图片（Markdown 相对图片与文件预览共用）。
   * @param {import('node:http').ServerResponse} res
   * @param {string} root
   * @param {string | null} rawPath
   */
  async #sendImage(res, root, rawPath) {
    if (typeof rawPath !== 'string' || rawPath.trim().length === 0) throw httpError('缺少 path', 400);
    const { realTarget } = await this.#resolveRooted(root, rawPath);
    const type = IMAGE_MIME[extname(realTarget).toLowerCase()];
    if (type === undefined) throw httpError('只支持图片文件', 415);
    let info;
    try {
      info = await stat(realTarget);
    } catch {
      throw httpError('文件不存在', 404);
    }
    if (!info.isFile() || info.size > 25 * 1024 * 1024) throw httpError('文件不可用或超过 25 MB', 413);
    let data;
    try {
      data = await readFile(realTarget);
    } catch {
      throw httpError('读取文件失败', 500);
    }
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': data.length,
      'Content-Disposition': 'inline',
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      // SVG 可能带脚本；用 sandbox 让它按静态图片处理。
      'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
    });
    res.end(data);
  }

  /**
   * 以附件形式流出一个工作区文件，交给手机浏览器/下载管理器保存。
   * @param {import('node:http').ServerResponse} res
   * @param {string} root
   * @param {string | null} rawPath
   */
  async #sendDownload(res, root, rawPath) {
    if (typeof rawPath !== 'string' || rawPath.trim().length === 0) throw httpError('缺少 path', 400);
    const { realTarget } = await this.#resolveRooted(root, rawPath);
    let info;
    try {
      info = await stat(realTarget);
    } catch {
      throw httpError('文件不存在', 404);
    }
    if (!info.isFile()) throw httpError('不是文件', 400);
    const name = basename(realTarget);
    res.writeHead(200, {
      'Content-Type': DOWNLOAD_MIME[extname(name).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Content-Disposition': contentDisposition(name),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    if (res.req?.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = createReadStream(realTarget);
    stream.on('error', (error) => {
      this.log(`pocket: download stream failed: ${error?.stack ?? error}`);
      res.destroy(error);
    });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }

  /**
   * 读取会话工作区里的图片，供 Markdown 中的相对路径图片使用。
   * 只允许会话 cwd 子树内的图片文件，避免把移动服务变成任意文件读取器。
   * @param {import('node:http').ServerResponse} res
   * @param {string} sessionId
   * @param {string | null} rawPath
   */
  async #workspaceFile(res, sessionId, rawPath) {
    const cwd = await this.#sessionCwd(sessionId);
    await this.#sendImage(res, cwd, rawPath);
  }

  /**
   * 读取会话图片/文件附件；`download` 为 true 时按附件保存。
   * @param {import('node:http').ServerResponse} res
   * @param {string} sessionId
   * @param {string} attachmentId
   * @param {boolean} [download]
   */
  async #attachment(res, sessionId, attachmentId, download = false) {
    const controller = this.#controller();
    const value = await controller.attachment({ sessionId, attachmentId });
    const data = Buffer.from(value.data, 'base64');
    const name = typeof value.attachment?.name === 'string' && value.attachment.name.length > 0
      ? value.attachment.name
      : attachmentId;
    res.writeHead(200, {
      'Content-Type': value.attachment.mediaType ?? 'application/octet-stream',
      'Cache-Control': 'private, max-age=86400',
      'Content-Length': data.length,
      ...(download ? { 'Content-Disposition': contentDisposition(name) } : {}),
    });
    res.end(data);
  }

  /**
   * 处理 WebSocket 升级：
   *   - `/ws/events?token=...`：首页全局事件（别的会话的提问/审批提示）；
   *   - `/ws/session/:id?token=...`：单个会话的消息流。
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:stream').Duplex} socket
   * @param {Buffer} head
   */
  #handleUpgrade(req, socket, head) {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (this.surface === 'desktop') {
        if (!this.#isAuthed(req, url)) {
          socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }
        void this.gui.handleUpgrade(req, socket, head).catch((error) => {
          this.log(`pocket: desktop websocket proxy failed: ${error?.stack ?? error}`);
          socket.destroy();
        });
        return;
      }
      const events = url.pathname === '/ws/events';
      const match = /^\/ws\/session\/([^/]+)$/u.exec(url.pathname);
      if ((!events && match === null) || this.wss === undefined) {
        socket.destroy();
        return;
      }
      if (!this.#isAuthed(req, url)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      const origin = req.headers.origin;
      if (typeof origin === 'string' && origin.length > 0) {
        try {
          if (new URL(origin).host !== req.headers.host) {
            socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
          }
        } catch {
          socket.destroy();
          return;
        }
      }
      const sessionId = events ? undefined : decodeURIComponent(match[1]);
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        if (events) this.#attachEvents(ws);
        else this.#attachSocket(ws, sessionId);
      });
    } catch {
      socket.destroy();
    }
  }

  /**
   * 注册前台提问与审批的 waterfall 监听器。
   * 只在有手机 WebSocket 连接时接管；否则 next() 交回桌面 UI。
   */
  #installInteractions() {
    if (this.interactionDisposers.length > 0) return;
    try {
      const offQuestion = this.ctx.on(
        'user-questions/request',
        (request, next) => this.#handleQuestionRequest(request, next),
        { global: true, prepend: true },
      );
      const offApproval = this.ctx.on(
        'approval/request',
        (request, next) => this.#handleApprovalRequest(request, next),
        { global: true, prepend: true },
      );
      this.interactionDisposers.push(offQuestion, offApproval);
    } catch (error) {
      this.log(`pocket: interaction listeners unavailable: ${error?.message ?? error}`);
    }
  }

  /**
   * @param {string} sessionId
   * @param {string} kind
   * @param {object} payload
   */
  #sendToSession(sessionId, kind, payload) {
    const sockets = this.sessionSockets.get(sessionId);
    if (sockets === undefined) return;
    const text = JSON.stringify({ kind, ...payload });
    for (const socket of sockets) {
      if (socket.readyState !== 1) continue;
      try {
        socket.send(text);
      } catch {
        /* socket 已关闭 */
      }
    }
  }

  /**
   * 给所有首页事件流推送一条消息；没有手机连着时直接返回。
   * @param {string} kind
   * @param {object} payload
   */
  #broadcastEvents(kind, payload) {
    if (this.notificationSockets.size === 0) return;
    const text = JSON.stringify({ kind, ...payload });
    for (const socket of this.notificationSockets) {
      if (socket.readyState !== 1) continue;
      try {
        socket.send(text);
      } catch {
        /* socket 已关闭 */
      }
    }
  }

  /**
   * 把一条待办压缩成首页提示需要的形状：会话标题、类型、摘要。
   * @param {string} requestId
   * @param {any} pending
   * @returns {object}
   */
  #interactionSummary(requestId, pending) {
    const cachedTitle = this.titleCache.get(pending.sessionId)?.title;
    const payload = pending.payload ?? {};
    const base = {
      requestId,
      sessionId: pending.sessionId,
      interactionKind: pending.kind,
      createdAt: pending.createdAt,
      ...(cachedTitle === undefined ? {} : { title: cachedTitle }),
    };
    if (pending.kind === 'question') {
      const questions = Array.isArray(payload.questions) ? payload.questions : [];
      const first = questions[0] ?? {};
      const preview = String(first.question ?? first.header ?? '').trim();
      return {
        ...base,
        count: questions.length,
        ...(preview.length === 0 ? {} : { preview: preview.slice(0, 140) }),
      };
    }
    const reason = String(payload.displayReason ?? payload.reason ?? '').trim();
    return {
      ...base,
      toolName: String(payload.toolName ?? '工具'),
      ...(reason.length === 0 ? {} : { preview: reason.slice(0, 140) }),
    };
  }

  /**
   * 当前所有待办（供首页事件流首次连接时补发）。
   * @returns {object[]}
   */
  #pendingSummaries() {
    const summaries = [];
    for (const [requestId, pending] of this.pendingInteractions) {
      summaries.push(this.#interactionSummary(requestId, pending));
    }
    return summaries;
  }

  /**
   * 广播一条新待办；标题缓存里没有时异步补读一次并更新。
   * @param {string} requestId
   * @param {any} pending
   */
  #announceInteraction(requestId, pending) {
    this.#broadcastEvents('interaction-pending', this.#interactionSummary(requestId, pending));
    if (this.titleCache.get(pending.sessionId)?.title !== undefined) return;
    void this.#sessionMeta(pending.sessionId).then(() => {
      const current = this.pendingInteractions.get(requestId);
      if (current === undefined) return;
      this.#broadcastEvents('interaction-update', this.#interactionSummary(requestId, current));
    }).catch(() => {
      /* 标题补读失败不影响提示 */
    });
  }

  /**
   * 结束一个手机端待办：从登记表移除、通知会话页收起卡片、通知首页撤掉提示。
   * @param {string} requestId
   * @returns {any | undefined} 被移除的待办
   */
  #completeInteraction(requestId) {
    const pending = this.pendingInteractions.get(requestId);
    if (pending === undefined) return undefined;
    this.pendingInteractions.delete(requestId);
    this.#sendToSession(pending.sessionId, 'interaction-closed', { requestId });
    this.#broadcastEvents('interaction-resolved', { requestId, sessionId: pending.sessionId });
    return pending;
  }

  /**
   * 结束一个手机端待办，通知所有手机收起卡片。
   * @param {string} requestId
   */
  #settleInteraction(requestId) {
    this.#completeInteraction(requestId);
  }

  /**
   * 让转发给桌面端的 pending 事件跟随手机端待办。
   * 手机先回答时 abort 这个信号：网关会给桌面端发 cancel 帧，撤掉残留的提问/审批弹窗。
   * 原始 signal 不受影响（组合信号只用来中止桌面那一路）。
   * @param {any} request
   * @returns {AbortController}
   */
  #desktopGate(request) {
    const gate = new AbortController();
    if (request === null || typeof request !== 'object') return gate;
    const original = request.signal;
    try {
      request.signal = original instanceof AbortSignal ? AbortSignal.any([original, gate.signal]) : gate.signal;
    } catch {
      /* 冻结的请求对象：桌面弹窗只能等它自己的信号 */
    }
    return gate;
  }

  /**
   * 处理前台提问请求：登记待办，手机在线就推给手机，并与桌面 answerer 赛跑。
   * 手机没在该会话时也登记，用户切过去时由 WebSocket 补发（见 #attachSocket）。
   * @param {any} request
   * @param {() => Promise<any>} next
   * @returns {Promise<any>}
   */
  async #handleQuestionRequest(request, next) {
    const agent = request?.agent;
    const sessionId = agent?.session?.id ?? agent?.id;
    if (sessionId === undefined) return next();

    const requestId = randomUUID();
    const gate = this.#desktopGate(request);
    const payload = {
      requestId,
      questions: Array.isArray(request?.questions) ? request.questions : [],
      callId: request?.wait?.callId,
      timed: request?.wait?.timed === true,
    };
    const mobile = new Promise((resolvePromise, rejectPromise) => {
      const pending = {
        kind: 'question',
        sessionId,
        payload,
        gate,
        createdAt: Date.now(),
        resolve: resolvePromise,
        reject: rejectPromise,
        close: () => rejectPromise(new Error('pocket interaction closed')),
      };
      this.pendingInteractions.set(requestId, pending);
      this.#announceInteraction(requestId, pending);
    });
    this.#sendToSession(sessionId, 'question-request', payload);

    const downstream = Promise.resolve().then(() => next());
    downstream.catch((error) => {
      const pending = this.pendingInteractions.get(requestId);
      if (pending === undefined) return;
      this.#settleInteraction(requestId);
      pending.reject(error);
    });
    const onAbort = () => {
      const pending = this.pendingInteractions.get(requestId);
      if (pending === undefined) return;
      this.#settleInteraction(requestId);
      pending.reject(new Error('question aborted'));
    };
    request?.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await Promise.race([mobile, downstream]);
    } finally {
      request?.signal?.removeEventListener('abort', onAbort);
      this.#settleInteraction(requestId);
    }
  }

  /**
   * 处理审批请求：登记待办，手机在线就推给手机，并与桌面 answerer 赛跑。
   * @param {any} request
   * @param {() => Promise<any>} next
   * @returns {Promise<any>}
   */
  async #handleApprovalRequest(request, next) {
    const agent = request?.agent;
    const sessionId = agent?.session?.id ?? agent?.id;
    if (sessionId === undefined) return next();

    const requestId = randomUUID();
    const gate = this.#desktopGate(request);
    const payload = {
      requestId,
      toolName: String(request?.toolName ?? 'tool'),
      ...(typeof request?.reason === 'string' ? { reason: request.reason } : {}),
      ...(typeof request?.displayReason === 'string' ? { displayReason: request.displayReason } : {}),
      ...(request?.callId === undefined ? {} : { callId: request.callId }),
    };
    const mobile = new Promise((resolvePromise, rejectPromise) => {
      const pending = {
        kind: 'approval',
        sessionId,
        payload,
        gate,
        createdAt: Date.now(),
        resolve: resolvePromise,
        reject: rejectPromise,
        close: () => resolvePromise('cancelled'),
      };
      this.pendingInteractions.set(requestId, pending);
      this.#announceInteraction(requestId, pending);
    });
    this.#sendToSession(sessionId, 'approval-request', payload);

    const downstream = Promise.resolve().then(() => next());
    downstream.catch((error) => {
      const pending = this.pendingInteractions.get(requestId);
      if (pending === undefined) return;
      this.#settleInteraction(requestId);
      pending.reject(error);
    });
    const onAbort = () => {
      const pending = this.pendingInteractions.get(requestId);
      if (pending === undefined) return;
      this.#settleInteraction(requestId);
      pending.resolve('cancelled');
    };
    request?.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await Promise.race([mobile, downstream]);
    } finally {
      request?.signal?.removeEventListener('abort', onAbort);
      this.#settleInteraction(requestId);
    }
  }

  /**
   * 手机通过 WS 或 HTTP 回答一个待办。
   * @param {string} sessionId
   * @param {string} requestId
   * @param {any} message
   * @returns {boolean}
   */
  #answerInteraction(sessionId, requestId, message) {
    const pending = this.pendingInteractions.get(requestId);
    if (pending === undefined || pending.sessionId !== sessionId) return false;
    if (pending.kind === 'question') {
      const answers = Array.isArray(message?.answers) ? message.answers : undefined;
      if (answers === undefined) return false;
      const expected = pending.payload.questions.map((question) => question.id);
      const received = answers.map((answer) => String(answer?.id ?? ''));
      if (received.length !== expected.length || !expected.every((id) => received.includes(id))) return false;
      const removed = this.#completeInteraction(requestId);
      if (removed === undefined) return false;
      removed.resolve({
        answers: answers.map((answer) => ({
          id: String(answer.id),
          selected: Array.isArray(answer.selected) ? answer.selected.map(String) : [],
          ...(typeof answer.custom === 'string' && answer.custom.length > 0 ? { custom: answer.custom } : {}),
        })),
      });
      // 撤掉桌面端因为同一次请求留下的弹窗。
      removed.gate?.abort();
      return true;
    }
    const outcome = message?.outcome;
    if (outcome !== 'allowed-once' && outcome !== 'rejected') return false;
    const removed = this.#completeInteraction(requestId);
    if (removed === undefined) return false;
    removed.resolve(outcome);
    removed.gate?.abort();
    return true;
  }

  #handleSocketMessage(ws, sessionId, raw) {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (message === null || typeof message !== 'object') return;
    if (message.kind === 'question-answer') {
      this.#answerInteraction(sessionId, String(message.requestId ?? ''), message);
    } else if (message.kind === 'approval-answer') {
      this.#answerInteraction(sessionId, String(message.requestId ?? ''), message);
    }
  }

  /**
   * 首页事件流。连接后先补发当前所有待办，之后实时推送新增/更新/结束。
   * 通知只用于“别的会话”的提示，回答仍走对应会话的 WebSocket。
   * @param {import('ws').WebSocket} ws
   */
  #attachEvents(ws) {
    this.notificationSockets.add(ws);
    const remove = () => this.notificationSockets.delete(ws);
    ws.on('close', remove);
    ws.on('error', remove);

    const heartbeat = setInterval(() => {
      if (ws.readyState === 1) {
        try {
          ws.ping();
        } catch {
          /* ignore */
        }
      }
    }, 30_000);
    heartbeat.unref?.();
    ws.on('close', () => clearInterval(heartbeat));
    ws.on('error', () => clearInterval(heartbeat));

    if (ws.readyState === 1) {
      try {
        ws.send(JSON.stringify({ kind: 'interactions', pending: this.#pendingSummaries() }));
      } catch {
        /* socket 已关闭 */
      }
    }
  }

  /**
   * 一条会话 WebSocket：先分批推送历史快照，再持续推送实时帧。
   * WebSocket 不会像 SSE 那样被 Cloudflare Quick Tunnel 的响应缓冲卡住。
   * @param {import('ws').WebSocket} ws
   * @param {string} sessionId
   */
  #attachSocket(ws, sessionId) {
    let controller;
    try {
      controller = this.#controller();
    } catch (error) {
      try {
        ws.send(JSON.stringify({ kind: 'failed', error: String(error?.message ?? error) }));
        ws.close();
      } catch {
        /* ignore */
      }
      return;
    }

    const abort = new AbortController();
    this.followers.add(abort);
    const release = () => this.followers.delete(abort);
    const peers = this.sessionSockets.get(sessionId) ?? new Set();
    peers.add(ws);
    this.sessionSockets.set(sessionId, peers);
    const releasePeer = () => {
      peers.delete(ws);
      if (peers.size === 0) this.sessionSockets.delete(sessionId);
    };
    ws.on('close', () => {
      abort.abort();
      release();
      releasePeer();
    });
    ws.on('error', () => {
      abort.abort();
      release();
      releasePeer();
    });
    ws.on('message', (raw) => this.#handleSocketMessage(ws, sessionId, raw));

    const send = (kind, payload) => {
      if (ws.readyState !== 1) return;
      try {
        ws.send(JSON.stringify({ kind, ...payload }));
      } catch {
        /* socket 已关闭 */
      }
    };

    const heartbeat = setInterval(() => {
      if (ws.readyState === 1) {
        try {
          ws.ping();
        } catch {
          /* ignore */
        }
      }
    }, 30_000);
    heartbeat.unref?.();
    ws.on('close', () => clearInterval(heartbeat));
    ws.on('error', () => clearInterval(heartbeat));

    void (async () => {
      try {
        send('hello', await this.#sessionMeta(sessionId));
        for (const pending of this.pendingInteractions.values()) {
          if (pending.sessionId !== sessionId) continue;
          send(pending.kind === 'question' ? 'question-request' : 'approval-request', pending.payload);
        }
        const generator = controller.follow({
          address: { kind: 'session', sessionId },
          maxMessages: FOLLOW_MAX_MESSAGES,
          turnWindow: { minMessages: 16, minTurns: 2 },
          assistantStream: true,
        }, abort.signal);
        for await (const frame of generator) {
          if (frame?.type === 'snapshot') {
            const snapshot = compactFrame(frame, this.display);
            send('snapshot-meta', {
              header: snapshot.header,
              cursor: snapshot.cursor,
              hasMore: snapshot.hasMore,
              count: snapshot.records.length,
            });
            for (let index = 0; index < snapshot.records.length; index += SNAPSHOT_BATCH_RECORDS) {
              send('snapshot-batch', { records: snapshot.records.slice(index, index + SNAPSHOT_BATCH_RECORDS) });
            }
            send('snapshot-end', {});
            continue;
          }
          const compacted = compactFrame(frame, this.display);
          if (compacted !== undefined) send('frame', { frame: compacted });
        }
      } catch (error) {
        if (!abort.signal.aborted) {
          this.log(`pocket: ws ${sessionId} failed: ${error?.stack ?? error}`);
          send('failed', { error: String(error?.message ?? error) });
        }
      } finally {
        clearInterval(heartbeat);
        release();
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
    })();
  }

  /**
   * SSE：打开会话并持续推送帧。
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {string} sessionId
   */
  async #follow(req, res, sessionId) {
    const controller = this.#controller();
    const abort = new AbortController();
    this.followers.add(abort);
    const release = () => this.followers.delete(abort);
    req.on('close', () => {
      abort.abort();
      release();
    });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    res.write(': connected\n\n');

    const send = (event, data) => {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 15_000);
    heartbeat.unref?.();

    try {
      send('hello', await this.#sessionMeta(sessionId));
      const generator = controller.follow({
        address: { kind: 'session', sessionId },
        maxMessages: FOLLOW_MAX_MESSAGES,
        turnWindow: { minMessages: 20, minTurns: 2 },
        assistantStream: true,
      }, abort.signal);
      for await (const frame of generator) {
        if (frame?.type === 'snapshot') {
          const snapshot = compactFrame(frame, this.display);
          send('snapshot-meta', {
            header: snapshot.header,
            cursor: snapshot.cursor,
            hasMore: snapshot.hasMore,
            count: snapshot.records.length,
          });
          for (let index = 0; index < snapshot.records.length; index += SNAPSHOT_BATCH_RECORDS) {
            send('snapshot-batch', { records: snapshot.records.slice(index, index + SNAPSHOT_BATCH_RECORDS) });
          }
          send('snapshot-end', {});
          continue;
        }
        const compacted = compactFrame(frame, this.display);
        if (compacted !== undefined) send('frame', compacted);
      }
      send('done', { ok: true });
    } catch (error) {
      if (!abort.signal.aborted) {
        this.log(`pocket: follow ${sessionId} failed: ${error?.stack ?? error}`);
        send('failed', { error: String(error?.message ?? error) });
      }
    } finally {
      release();
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    }
  }
}

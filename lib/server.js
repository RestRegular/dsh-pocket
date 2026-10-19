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
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TunnelManager } from './tunnel.js';
import { ensureToken, rotateToken } from './state.js';
import { encodeQrMatrix } from './qrcode.js';

/** 包根目录（lib/server.js 的上一级）。 */
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 移动页面静态资源目录。 */
const WEB_ROOT = join(PACKAGE_ROOT, 'web');

/** 访问令牌的 Cookie 名。 */
export const COOKIE_NAME = 'dsh_pocket';

/** 会话跟随一次最多带回多少条消息。 */
const FOLLOW_MAX_MESSAGES = 40;

/** 单条字符串上限：工具输出/思考链过大时手机端没有带宽意义。 */
const WIRE_STRING_LIMIT = 20_000;

/** 截断标记。 */
const TRUNCATED_MARK = '\n…（Pocket 已截断，完整内容请在桌面端查看）';

/** POST 请求体上限。 */
const BODY_LIMIT = 1_000_000;

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

/** 移动页面的安全策略。 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
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
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        rejectPromise(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rejectPromise);
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
 * 本机所有非内部 IPv4 地址。优先排除虚拟网卡，避免把 VMware / Hyper-V
 * 的地址当成手机可访问的局域网地址；若全部被排除则回退到完整列表。
 * @returns {string[]}
 */
function lanAddresses() {
  const virtual = /(vEthernet|VMware|VirtualBox|Hyper-V|Loopback|WSL|Tailscale|ZeroTier|Docker|TAP-)/iu;
  const physical = [];
  const all = [];
  const interfaces = networkInterfaces();
  for (const [name, list] of Object.entries(interfaces)) {
    for (const info of list ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      all.push(info.address);
      if (!virtual.test(name)) physical.push(info.address);
    }
  }
  return physical.length > 0 ? physical : all;
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
 * @param {number} depth
 * @returns {unknown}
 */
function shrinkValue(value, depth = 0) {
  if (depth > 8) return value;
  if (typeof value === 'string') {
    return value.length > WIRE_STRING_LIMIT ? `${value.slice(0, WIRE_STRING_LIMIT)}${TRUNCATED_MARK}` : value;
  }
  if (Array.isArray(value)) return value.map((item) => shrinkValue(item, depth + 1));
  if (value !== null && typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) result[key] = shrinkValue(item, depth + 1);
    return result;
  }
  return value;
}

/**
 * 只压缩消息/工具事件里的数据；控制类事件保持原样。
 * @param {any} event
 * @returns {any}
 */
function shrinkEvent(event) {
  if (event === null || typeof event !== 'object') return event;
  if (event.type !== 'tool/result' && event.type !== 'tool/call') return event;
  return { ...event, data: shrinkValue(event.data) };
}

/**
 * 压缩整个 follow 帧。
 * @param {any} frame
 * @returns {any}
 */
function shrinkFrame(frame) {
  if (frame === null || typeof frame !== 'object') return frame;
  if (frame.type === 'snapshot' && Array.isArray(frame.records)) {
    return {
      ...frame,
      records: frame.records.map((record) => (
        record?.type === 'event' ? { type: 'event', event: shrinkEvent(record.event) } : record
      )),
    };
  }
  if (frame.type === 'event') return { type: 'event', event: shrinkEvent(frame.event) };
  return frame;
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
   * }} config
   * @param {(message: string) => void} [log]
   */
  constructor(ctx, config, log) {
    this.ctx = ctx;
    this.config = config;
    this.log = log ?? (() => {});
    this.token = '';
    this.server = undefined;
    this.port = 0;
    this.bindHost = '';
    this.startedAt = 0;
    this.starting = undefined;
    /** 正在跟随的 SSE 连接；关闭服务时先中止它们，避免 close() 一直等长连接。 */
    this.followers = new Set();
    /** 会话标题/目录缓存：列表每 8 秒轮询一次，冷会话折标题不值得重复读盘。 */
    this.titleCache = new Map();
    this.tunnel = new TunnelManager({
      port: 0,
      mode: config.tunnel,
      cloudflaredPath: config.cloudflaredPath,
      customCommand: config.customCommand,
      publicUrl: config.publicUrl,
      onStatus: (status) => {
        if (status.state === 'error' && status.error !== undefined) {
          this.log(`pocket: tunnel error: ${status.error}`);
        }
      },
      log: (message) => this.log(message),
    });
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
    this.log(`pocket: mobile server on http://${host}:${this.port}`);

    if (this.config.tunnel !== 'off' && this.config.autoStart) {
      void this.startTunnel();
    }
  }

  /** 关闭 HTTP 服务与隧道。 */
  async stop() {
    this.tunnel.stop();
    for (const abort of this.followers) abort.abort();
    this.followers.clear();
    const server = this.server;
    this.server = undefined;
    this.port = 0;
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
   * 当前状态下所有可用的入口地址。
   * @param {boolean} withToken
   * @returns {{
   *   local: string,
   *   lan: string[],
   *   publicUrl?: string,
   *   access: { local: string, lan: string[], publicUrl?: string },
   * }}
   */
  urls(withToken) {
    const suffix = withToken ? `/?token=${encodeURIComponent(this.token)}` : '/';
    const local = `http://127.0.0.1:${this.port}${suffix}`;
    const lan = lanAddresses().map((address) => `http://${address}:${this.port}${suffix}`);
    const publicUrl = this.tunnel.snapshot().url;
    return {
      local,
      lan,
      publicUrl: publicUrl === undefined ? undefined : `${publicUrl}${suffix}`,
      access: {
        local: `http://127.0.0.1:${this.port}${suffix}`,
        lan,
        publicUrl: publicUrl === undefined ? undefined : `${publicUrl}${suffix}`,
      },
    };
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
    const shareUrl = urls.publicUrl ?? urls.lan[0] ?? urls.local;
    const qr = withToken && typeof shareUrl === 'string' && shareUrl.length > 0
      ? { url: shareUrl, image: qrDataUrl(shareUrl, 240) }
      : undefined;
    return {
      ok: true,
      version: '0.1.0',
      startedAt: this.startedAt,
      server: {
        listening: this.listening,
        port: this.port,
        host: this.bindHost,
        lan: this.config.lan,
        urls: {
          local: urls.local,
          lan: urls.lan,
          publicUrl: urls.publicUrl,
        },
      },
      tunnel: this.tunnel.snapshot(),
      guiUrl,
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

      if (pathname === '/api/sessions' && method === 'GET') {
        sendJson(res, { ok: true, items: await this.#listSessions() });
        return;
      }

      if (pathname === '/api/sessions' && method === 'POST') {
        const body = await readJson(req);
        const cwd = typeof body.cwd === 'string' && body.cwd.trim().length > 0 ? body.cwd.trim() : undefined;
        sendJson(res, { ok: true, ...(await this.#createSession(cwd)) });
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
          const mode = body.mode === 'steer' ? 'steer' : 'queue';
          sendJson(res, { ok: true, ...(await this.#prompt(sessionId, text, mode)) });
          return;
        }
        if (action === 'cancel' && method === 'POST') {
          const result = await this.#cancel(sessionId);
          sendJson(res, { ok: true, ...result });
          return;
        }
        if (action === 'attachments' && typeof parts[4] === 'string' && method === 'GET') {
          await this.#attachment(res, sessionId, parts[4]);
          return;
        }
      }

      sendJson(res, { ok: false, error: 'Not Found' }, 404);
    } catch (error) {
      const message = String(error?.message ?? error);
      this.log(`pocket: API ${pathname} failed: ${error?.stack ?? error}`);
      sendJson(res, { ok: false, error: message }, 500);
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
    return visible.map((item) => {
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
    return controller.page({
      address: { kind: 'session', sessionId },
      throughSeq: Number.isInteger(throughSeq) ? throughSeq : -1,
      beforeSeq: Number.isInteger(beforeSeq) ? beforeSeq : undefined,
      maxMessages: FOLLOW_MAX_MESSAGES,
      turnWindow: { minMessages: 24, minTurns: 2 },
    }, new AbortController().signal);
  }

  /**
   * 发送提示词。
   * @param {string} sessionId
   * @param {string} text
   * @param {'queue' | 'steer'} mode
   * @returns {Promise<{ requestId: string }>}
   */
  async #prompt(sessionId, text, mode) {
    if (text.trim().length === 0) throw new Error('消息不能为空');
    if (text.length > 100_000) throw new Error('消息过长');
    const controller = this.#controller();
    const requestId = randomUUID();
    await controller.prompt({
      requestId,
      sessionId,
      mode,
      content: [{ type: 'text', text }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }, new AbortController().signal);
    return { requestId };
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
   * 读取会话图片附件。
   * @param {import('node:http').ServerResponse} res
   * @param {string} sessionId
   * @param {string} attachmentId
   */
  async #attachment(res, sessionId, attachmentId) {
    const controller = this.#controller();
    const value = await controller.attachment({ sessionId, attachmentId });
    const data = Buffer.from(value.data, 'base64');
    res.writeHead(200, {
      'Content-Type': value.attachment.mediaType ?? 'application/octet-stream',
      'Cache-Control': 'private, max-age=86400',
      'Content-Length': data.length,
    });
    res.end(data);
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
        turnWindow: { minMessages: 24, minTurns: 2 },
        assistantStream: true,
      }, abort.signal);
      for await (const frame of generator) {
        send('frame', shrinkFrame(frame));
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

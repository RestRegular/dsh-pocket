/**
 * dsh-pocket — Host half.
 *
 * 两件事：
 *   1. 起一个独立的移动端 HTTP 服务（`PocketServer`），能只绑回环、也能绑
 *      局域网，并可选地拉起一条公网隧道；
 *   2. 在桌面 Web GUI 注册 `/dsh-pocket` 回环路由，给「Pocket 随身访问」
 *      面板提供状态与启停控制。
 *
 * 与 DSH 的全部耦合都发生在 `PocketServer` 通过 `ctx.get(...)` 调用宿主服务，
 * 本文件只负责配置归一、生命周期与面板 API。
 *
 * @module dsh-pocket
 */

import { PocketServer } from './server.js';
import { TUNNEL_MODES } from './tunnel.js';

/** Loader 行名。 */
export const name = 'pocket';

/**
 * `webServer` 用于桌面面板路由；会话能力按需从宿主上下文取，缺少时对应
 * API 返回明确错误，而不是让整个插件启动失败。
 */
export const inject = ['webServer'];

/** 面板路由前缀。 */
const ROUTE = '/dsh-pocket';

/**
 * 读取正整数配置。
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function positiveInt(value, fallback) {
  const number = typeof value === 'string' ? Number(value) : value;
  return Number.isInteger(number) && number >= 0 && number <= 65535 ? number : fallback;
}

/**
 * 归一化插件配置。
 * @param {Record<string, unknown> | undefined} raw
 * @param {(message: string) => void} warn
 * @returns {{
 *   port: number,
 *   lan: boolean,
 *   tunnel: string,
 *   autoStart: boolean,
 *   token: string | undefined,
 *   publicUrl: string | undefined,
 *   cloudflaredPath: string | undefined,
 *   customCommand: string | undefined,
 *   sshHost: string | undefined,
 *   sshUser: string | undefined,
 *   sshPort: number,
 *   sshKeyPath: string | undefined,
 *   sshRemotePort: number,
 *   sshExposePort: number,
 *   sshExposeHost: string | undefined,
 *   sshPublicUrl: string | undefined,
 *   keepAwake: boolean,
 *   keepAwakeDisplay: boolean,
 * }}
 */
function normalizeConfig(raw, warn) {
  const config = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  let tunnel = typeof config.tunnel === 'string' ? config.tunnel.trim() : 'auto';
  if (!TUNNEL_MODES.includes(tunnel)) {
    warn(`pocket: 未知 tunnel 模式 "${tunnel}"，回退到 auto`);
    tunnel = 'auto';
  }
  const text = (value) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined);
  return {
    port: positiveInt(config.port, 8790),
    lan: config.lan === true,
    tunnel,
    autoStart: config.autoStart !== false,
    token: text(config.token),
    publicUrl: text(config.publicUrl),
    cloudflaredPath: text(config.cloudflaredPath),
    customCommand: text(config.customCommand),
    sshHost: text(config.sshHost),
    sshUser: text(config.sshUser) ?? 'root',
    sshPort: positiveInt(config.sshPort, 22),
    sshKeyPath: text(config.sshKeyPath),
    sshRemotePort: positiveInt(config.sshRemotePort, 8790),
    sshExposePort: positiveInt(config.sshExposePort, 80),
    sshExposeHost: text(config.sshExposeHost),
    sshPublicUrl: text(config.sshPublicUrl),
    keepAwake: config.keepAwake === true,
    keepAwakeDisplay: config.keepAwakeDisplay !== false,
  };
}

/**
 * 判断请求是否来自本机回环。
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * 读 JSON 请求体。
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<any>}
 */
function readJson(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > 1_000_000) {
        rejectPromise(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim().length === 0) {
        resolvePromise({});
        return;
      }
      try {
        resolvePromise(JSON.parse(text));
      } catch {
        rejectPromise(new Error('无效的 JSON 请求体'));
      }
    });
    req.on('error', rejectPromise);
  });
}

/**
 * 发送 JSON。
 * @param {import('node:http').ServerResponse} res
 * @param {unknown} payload
 * @param {number} status
 */
function sendJson(res, payload, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

/**
 * `pocket_share` 输出 schema。
 */
const POCKET_SHARE_OUTPUT = {
  type: 'object',
  properties: {
    local: { type: 'string' },
    lan: { type: 'array', items: { type: 'string' } },
    publicUrl: { type: 'string' },
    tunnelState: { type: 'string' },
    tunnelProvider: { type: 'string' },
    note: { type: 'string' },
  },
  required: ['local', 'lan', 'tunnelState', 'note'],
  additionalProperties: false,
};

/**
 * 注册 `pocket_share`：把手机入口地址交给模型/用户。
 * @param {PocketServer} pocket
 * @returns {object}
 */
function pocketShareTool(pocket) {
  return {
    name: 'pocket_share',
    description:
      'Return the phone access URLs of this DSH host from the dsh-pocket plugin. Use it when the user asks for a link to open this session on a phone, or asks whether the pocket tunnel is running. URLs contain an access token; treat them as private. A LAN URL only works on the same network; the public URL works anywhere the tunnel is online.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: {
      schema: POCKET_SHARE_OUTPUT,
      render(_args, value) {
        const lines = [
          `tunnel: ${value.tunnelState}${value.tunnelProvider === undefined ? '' : ` (${value.tunnelProvider})`}`,
          `local: ${value.local}`,
          ...value.lan.map((url) => `lan: ${url}`),
          ...(value.publicUrl === undefined ? [] : [`public: ${value.publicUrl}`]),
          value.note,
        ];
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute() {
      const current = pocket.status(true);
      const tunnel = current.tunnel;
      return {
        local: current.server.urls.local,
        lan: current.server.urls.lan,
        ...(current.server.urls.publicUrl === undefined ? {} : { publicUrl: current.server.urls.publicUrl }),
        tunnelState: tunnel.state,
        ...(tunnel.provider === undefined ? {} : { tunnelProvider: tunnel.provider }),
        note: '链接带有 128 位访问令牌，请不要转发到公开场合；令牌可在桌面「Pocket 随身访问」面板轮换。',
      };
    },
  };
}

/**
 * 插件体。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [config]
 */
export function apply(ctx, config) {
  const warn = (message) => {
    try {
      ctx.logger?.warn?.(message);
    } catch {
      /* ignore */
    }
  };
  const info = (message) => {
    try {
      ctx.logger?.info?.(message);
    } catch {
      /* ignore */
    }
  };

  const normalized = normalizeConfig(config, warn);
  const pocket = new PocketServer(ctx, normalized, info);

  ctx.effect(() => {
    void pocket.start().catch((error) => {
      warn(`pocket: 移动端服务启动失败：${error?.stack ?? error}`);
    });
    return () => {
      void pocket.stop();
    };
  }, 'pocket: mobile server');

  // 桌面面板 API：只接受回环请求。
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE,
    async handler(req, res) {
      if (!isLoopback(req)) {
        sendJson(res, { ok: false, error: '只接受本机请求' }, 403);
        return;
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      const op = url.searchParams.get('op') ?? 'status';
      try {
        if (req.method === 'GET') {
          if (op === 'status') {
            sendJson(res, { ok: true, status: pocket.status(true) });
            return;
          }
          sendJson(res, { ok: false, error: `未知操作 "${op}"` }, 404);
          return;
        }

        if (req.method === 'POST') {
          const body = await readJson(req);
          const action = String(body?.op ?? op);
          if (action === 'tunnel-start') {
            void pocket.startTunnel();
          } else if (action === 'tunnel-stop') {
            pocket.stopTunnel();
          } else if (action === 'tunnel-restart') {
            pocket.stopTunnel();
            void pocket.startTunnel();
          } else if (action === 'switch-tunnel') {
            const provider = typeof body.provider === 'string' ? body.provider : 'cloudflared';
            const sshHost = typeof body.sshHost === 'string' ? body.sshHost : undefined;
            await pocket.switchTunnel(provider, sshHost);
          } else if (action === 'set-lan') {
            await pocket.setLanAddress(typeof body?.address === 'string' ? body.address : '');
          } else if (action === 'rotate-token') {
            await pocket.rotateToken();
          } else if (action === 'keep-awake') {
            await pocket.setKeepAwake(body?.enabled === true);
          } else if (action === 'set-display') {
            await pocket.setDisplay(body?.display);
          } else if (action === 'restart') {
            await pocket.stop();
            await pocket.start();
          } else {
            sendJson(res, { ok: false, error: `未知操作 "${action}"` }, 404);
            return;
          }
          sendJson(res, { ok: true, status: pocket.status(true) });
          return;
        }

        sendJson(res, { ok: false, error: '只支持 GET 与 POST' }, 405);
      } catch (error) {
        warn(`pocket: 面板操作失败：${error?.stack ?? error}`);
        sendJson(res, { ok: false, error: String(error?.message ?? error) }, 500);
      }
    },
  }), 'pocket: panel route');

  // 模型工具独立降级：没有 tools 服务的组合只是少一个工具。
  ctx.inject(['tools'], (scoped) => {
    try {
      scoped.effect(
        () => scoped.tools.register(pocketShareTool(pocket)),
        'pocket: pocket_share tool',
      );
    } catch (error) {
      warn(`pocket: pocket_share 注册失败：${error?.message ?? error}`);
    }
  });
}

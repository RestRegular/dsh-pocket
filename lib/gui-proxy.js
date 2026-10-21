/**
 * dsh-pocket — 桌面界面直通（反向代理）。
 *
 * 把宿主 `webServer` 正在服务的 Web GUI（`@deepseek-ai/dsh-web-frontend`）
 * 整页代理到 Pocket 的监听端口：手机浏览器看到的就是桌面端同一份渲染代码，
 * 插件注入的 client bundle 也一并存在，因此插件面板、设置、终端等无需重写。
 *
 * 认证分两层：
 *   - 手机 → Pocket：继续用 Pocket 自己的令牌/Cookie（由 PocketServer 把关）；
 *   - Pocket → GUI：Web GUI 只认绑定 authority 的签名 Cookie，这里用
 *     `connection.authenticatedUrl()` 拿启动令牌换一次，之后固定注入。
 *
 * 反代时 Host 固定成 Web GUI 的 origin，Origin/Referer 同步改写：GUI 的
 * `isTrustedApiRequest` 要求 Host 为回环、Origin 与之同源，否则 `/api` 与
 * WebSocket 会被拒。
 *
 * @module dsh-pocket/gui-proxy
 */

import { readFileSync } from 'node:fs';
import { Agent, request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 换来的凭据最多缓存多久；换 cookie 很便宜，但没必要每个请求都换。 */
const COOKIE_CACHE_MS = 10 * 60 * 1000;

/** 一条连接最多挂多久，避免把 GUI 的 keep-alive 连接留到进程退出。 */
const MAX_SOCKETS = 16;

/** 注入的移动端样式与抽屉脚本（随包发布，和桌面界面的结构解耦）。 */
const SURFACE_ROOT = fileURLToPath(new URL('./surface/', import.meta.url));
const MOBILE_CSS = readFileSync(join(SURFACE_ROOT, 'mobile.css'), 'utf8');
const MOBILE_JS = readFileSync(join(SURFACE_ROOT, 'mobile.js'), 'utf8');

/** HTML 注入时最多缓冲多少字节；超出就退回流式转发。 */
const INJECT_LIMIT = 4 * 1024 * 1024;

/**
 * 桌面界面直通代理。
 */
export class GuiProxy {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @param {(message: string) => void} [log]
   * @param {{ shouldInject?: () => boolean }} [options]
   */
  constructor(ctx, log, options = {}) {
    this.ctx = ctx;
    this.log = log ?? (() => {});
    /** 是否给页面注入窄屏适配样式/脚本。 */
    this.shouldInject = options.shouldInject ?? (() => false);
    /** 已换好的 GUI Cookie（`name=value`）。 */
    this.cookie = undefined;
    this.cookieAt = 0;
    /** 并发换 cookie 时只发一次请求。 */
    this.minting = undefined;
    this.agent = new Agent({ keepAlive: true, maxSockets: MAX_SOCKETS, timeout: 30_000 });
  }

  /**
   * 桌面 Web GUI 的 origin；不可用时返回 undefined（不会抛错）。
   * @returns {string | undefined}
   */
  available() {
    try {
      return this.#target().origin;
    } catch {
      return undefined;
    }
  }

  /**
   * @returns {URL}
   */
  #target() {
    const webServer = this.ctx.get('webServer');
    const origin = webServer?.getOrigin?.();
    if (typeof origin !== 'string' || origin.length === 0) {
      throw new Error('桌面 Web 界面没有在运行（webServer 不可用）');
    }
    return new URL(origin);
  }

  /**
   * 取一条可用于反代的 GUI Cookie。
   * @param {boolean} [force] - 强制重新换取（收到 401 时）。
   * @returns {Promise<string>}
   */
  async cookieValue(force = false) {
    if (!force && this.cookie !== undefined && Date.now() - this.cookieAt < COOKIE_CACHE_MS) {
      return this.cookie;
    }
    if (this.minting !== undefined) return this.minting;
    this.minting = this.#mint().finally(() => {
      this.minting = undefined;
    });
    return this.minting;
  }

  /**
   * 用进程启动令牌换一次 GUI 侧 Cookie。
   * @returns {Promise<string>}
   */
  async #mint() {
    const target = this.#target();
    const connection = this.ctx.get('connection');
    if (connection === undefined || typeof connection.authenticatedUrl !== 'function') {
      throw new Error('缺少 connection 服务，无法为桌面界面换取访问凭据');
    }
    const url = connection.authenticatedUrl(target.origin);
    const response = await fetch(url, { redirect: 'manual', headers: { accept: 'text/html' } });
    const values = response.headers.getSetCookie?.() ?? [];
    const raw = values.find((value) => /max-age=/iu.test(value)) ?? values[0];
    if (raw === undefined) {
      throw new Error(`桌面界面拒绝换取凭据（HTTP ${response.status}）`);
    }
    this.cookie = raw.split(';', 1)[0];
    this.cookieAt = Date.now();
    this.log('pocket: desktop surface credential refreshed');
    return this.cookie;
  }

  /**
   * 改写发往 GUI 的请求头：Host/Cookie 固定，Origin/Referer 改成 GUI 自己的。
   * @param {import('node:http').IncomingMessage} req
   * @param {string} cookie
   * @returns {Record<string, string | string[] | undefined>}
   */
  #headers(req, cookie) {
    const target = this.#target();
    const headers = { ...req.headers };
    headers.host = target.host;
    headers.cookie = cookie;
    delete headers['x-pocket-token'];
    // 需要对 HTML 做注入时，别让上游压成 gzip/br，否则要在这里解压。
    if (this.shouldInject()) {
      const pathname = (req.url ?? '/').split('?')[0];
      if (pathname === '/' || pathname === '/index.html') headers['accept-encoding'] = 'identity';
    }
    if (headers.origin !== undefined) headers.origin = target.origin;
    if (headers.referer !== undefined) {
      try {
        const referer = new URL(headers.referer);
        headers.referer = `${target.origin}${referer.pathname}${referer.search}`;
      } catch {
        delete headers.referer;
      }
    }
    return headers;
  }

  /**
   * 把一次 HTTP 请求转发给 GUI。
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @returns {Promise<void>}
   */
  async handleHttp(req, res) {
    const target = this.#target();
    const method = req.method ?? 'GET';
    const canRetry = method === 'GET' || method === 'HEAD';

    const send = async (retry) => {
      const cookie = await this.cookieValue(retry);
      return new Promise((resolve, reject) => {
        const upstream = httpRequest({
          hostname: target.hostname,
          port: target.port,
          method,
          path: req.url,
          headers: this.#headers(req, cookie),
          agent: this.agent,
        });
        upstream.on('response', (upstreamRes) => resolve({ upstream, upstreamRes }));
        upstream.on('error', reject);
        req.on('aborted', () => upstream.destroy());
        req.pipe(upstream);
      });
    };

    const first = await send(false);
    if (first.upstreamRes.statusCode === 401 && canRetry) {
      first.upstreamRes.resume();
      first.upstream.destroy();
      const retried = await send(true);
      this.#pipe(retried.upstreamRes, res, retried.upstream, method !== 'HEAD');
      return;
    }
    this.#pipe(first.upstreamRes, res, first.upstream, method !== 'HEAD');
  }

  /**
   * @param {import('node:http').IncomingMessage} upstreamRes
   * @param {import('node:http').ServerResponse} res
   * @param {import('node:http').ClientRequest} upstream
   * @param {boolean} canInject
   */
  #pipe(upstreamRes, res, upstream, canInject) {
    const target = this.#target();
    const headers = { ...upstreamRes.headers };
    // GUI 侧 Cookie 绑定回环 authority，不能泄漏给手机；Pocket 有自己的 Cookie。
    delete headers['set-cookie'];
    if (typeof headers.location === 'string' && headers.location.startsWith(target.origin)) {
      headers.location = headers.location.slice(target.origin.length) || '/';
    }
    const contentType = String(headers['content-type'] ?? '');
    const injectable = canInject
      && this.shouldInject()
      && contentType.includes('text/html')
      && headers['content-encoding'] === undefined;
    if (injectable) {
      this.#pipeInjected(upstreamRes, res, headers);
      return;
    }
    res.writeHead(upstreamRes.statusCode ?? 502, headers);
    upstreamRes.pipe(res);
    res.on('close', () => {
      if (!upstreamRes.complete) upstreamRes.destroy();
    });
  }

  /**
   * 缓冲一小段 HTML，注入窄屏样式与抽屉脚本后一次写入；超限则退回流式转发。
   * @param {import('node:http').IncomingMessage} upstreamRes
   * @param {import('node:http').ServerResponse} res
   * @param {Record<string, string | string[] | undefined>} headers
   */
  #pipeInjected(upstreamRes, res, headers) {
    const chunks = [];
    let size = 0;
    let streaming = false;
    const startStreaming = () => {
      streaming = true;
      delete headers['content-length'];
      res.writeHead(upstreamRes.statusCode ?? 502, headers);
      for (const chunk of chunks) res.write(chunk);
      chunks.length = 0;
      upstreamRes.pipe(res);
    };
    upstreamRes.on('data', (chunk) => {
      if (streaming) return;
      size += chunk.length;
      if (size > INJECT_LIMIT) {
        startStreaming();
        return;
      }
      chunks.push(chunk);
    });
    upstreamRes.on('end', () => {
      if (streaming) return;
      const body = Buffer.from(this.#injectHtml(Buffer.concat(chunks).toString('utf8')), 'utf8');
      headers['content-length'] = String(body.length);
      delete headers['transfer-encoding'];
      res.writeHead(upstreamRes.statusCode ?? 502, headers);
      res.end(body);
    });
    upstreamRes.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    res.on('close', () => {
      if (!upstreamRes.complete) upstreamRes.destroy();
    });
  }

  /**
   * 在壳页 head/body 里插入移动端适配资源。
   * @param {string} html
   * @returns {string}
   */
  #injectHtml(html) {
    const style = `<style id="dsh-pocket-surface-css">${MOBILE_CSS}</style>`;
    const script = `<script id="dsh-pocket-surface-js">${MOBILE_JS}</script>`;
    let out = html.includes('</head>') ? html.replace('</head>', `${style}</head>`) : `${style}${html}`;
    out = out.includes('</body>') ? out.replace('</body>', `${script}</body>`) : `${out}${script}`;
    return out;
  }

  /**
   * 转发 WebSocket 升级（GUI 的 `/api/remote.mux` 等）。
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:net').Socket} socket
   * @param {Buffer} head
   * @returns {Promise<void>}
   */
  async handleUpgrade(req, socket, head) {
    const target = this.#target();
    const cookie = await this.cookieValue();
    const upstream = httpRequest({
      hostname: target.hostname,
      port: target.port,
      method: 'GET',
      path: req.url,
      headers: this.#headers(req, cookie),
      agent: this.agent,
    });

    upstream.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
      let raw = 'HTTP/1.1 101 Switching Protocols\r\n';
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        if (Array.isArray(value)) {
          for (const item of value) raw += `${key}: ${item}\r\n`;
        } else {
          raw += `${key}: ${value}\r\n`;
        }
      }
      socket.write(`${raw}\r\n`);
      if (upstreamHead.length > 0) socket.write(upstreamHead);
      if (head.length > 0) upstreamSocket.write(head);
      upstreamSocket.pipe(socket).pipe(upstreamSocket);
      upstreamSocket.on('error', () => socket.destroy());
      socket.on('error', () => upstreamSocket.destroy());
      socket.on('close', () => upstreamSocket.destroy());
    });
    upstream.on('response', (upstreamRes) => {
      const status = upstreamRes.statusCode ?? 502;
      socket.end(`HTTP/1.1 ${status} ${upstreamRes.statusMessage ?? 'Bad Gateway'}\r\nConnection: close\r\n\r\n`);
    });
    upstream.on('error', () => socket.destroy());
    upstream.end();
  }

  /** 释放 keep-alive 连接。 */
  dispose() {
    this.agent.destroy();
  }
}

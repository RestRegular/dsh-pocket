/**
 * dsh-pocket — 企业微信消息推送。
 *
 * 只做一件事：把新的公网地址发到用户的企业微信。支持两种最常见的接法：
 *
 *   webhook  群机器人 Webhook（`https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…`），
 *            也可以只填 key；markdown 消息，链接可直接点。
 *   app      企业应用消息：corpId + secret + agentId + toUser，需要先换
 *            access_token（缓存到过期前 2 分钟）。
 *
 * 推送失败只记录，不影响隧道本身；所有凭据都只留在本机 `state.json`（0600），
 * 日志与状态接口里不会出现完整 key。
 *
 * @module dsh-pocket/notify
 */

/** 群机器人 Webhook。 */
const WEBHOOK_ENDPOINT = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send';

/** 换取 access_token。 */
const TOKEN_ENDPOINT = 'https://qyapi.weixin.qq.com/cgi-bin/gettoken';

/** 应用消息。 */
const MESSAGE_ENDPOINT = 'https://qyapi.weixin.qq.com/cgi-bin/message/send';

/** 单次请求超时。 */
const REQUEST_TIMEOUT_MS = 10_000;

/** access_token 提前多久失效，避免临界时刻用到刚过期的令牌。 */
const TOKEN_MARGIN_MS = 120_000;

/** 企业微信 markdown/text 的内容上限是 4096 字节，留一点余量。 */
const MAX_CONTENT_CHARS = 3_800;

/**
 * 把用户输入归一成 Webhook 地址：允许只填 key，也允许粘贴完整 URL。
 * @param {string} input
 * @returns {string}
 */
function webhookUrl(input) {
  if (input.length === 0) return '';
  if (!input.includes('/') && /^[A-Za-z0-9-]{16,}$/u.test(input)) {
    return `${WEBHOOK_ENDPOINT}?key=${input}`;
  }
  return input;
}

/**
 * 归一化通知配置。缺省字段保持空值，由调用方决定合并策略。
 * @param {unknown} raw
 * @returns {{
 *   enabled: boolean,
 *   webhook: string,
 *   corpId: string,
 *   secret: string,
 *   agentId: string,
 *   toUser: string,
 *   withToken: boolean,
 *   notifyApprovals: boolean,
 *   notifyQuestions: boolean,
 *   notifyComplete: boolean,
 *   notifySelfHosted: boolean,
 * }}
 */
export function normalizeNotifyConfig(raw) {
  const value = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const text = (input) => (typeof input === 'string' ? input.trim() : '');
  return {
    // 填了 Webhook 就默认生效；只有显式关掉才不推送，少一个必填开关。
    enabled: value.enabled !== false,
    webhook: webhookUrl(text(value.webhook)),
    corpId: text(value.corpId),
    secret: text(value.secret),
    agentId: text(value.agentId),
    toUser: text(value.toUser) || '@all',
    withToken: value.withToken !== false,
    // 阻塞型交互（工具审批 / 用户提问）独立开关，默认开启；总开关 enabled 仍是前提。
    notifyApprovals: value.notifyApprovals !== false,
    notifyQuestions: value.notifyQuestions !== false,
    // 任务完成（会话从 running 回到 idle）独立开关，默认开启；总开关 enabled 仍是前提。
    notifyComplete: value.notifyComplete !== false,
    // 自建服务器（ssh / custom）通道是否也推送通知，默认开启；可在设置里关掉保持安静。
    notifySelfHosted: value.notifySelfHosted !== false,
  };
}

/**
 * 自建服务器通道：这两种 provider 的地址固定，用户可选择是否推送通知。
 * @param {string | undefined} provider
 * @returns {boolean}
 */
function isSelfHostedProvider(provider) {
  return provider === 'ssh' || provider === 'custom';
}

/**
 * 一次推送的统一门控：总开关 + 自建服务器通道开关。
 * @param {ReturnType<typeof normalizeNotifyConfig>} config
 * @param {string | undefined} provider 当前公网通道，用于自建服务器判断。
 * @returns {{ ok: boolean, error?: string }}
 */
function gateProvider(config, provider) {
  if (config.enabled !== true) return { ok: false, error: '企业微信推送未开启' };
  if (isSelfHostedProvider(provider) && config.notifySelfHosted !== true) {
    return { ok: false, error: '自建服务器通道推送已关闭' };
  }
  return { ok: true };
}

/**
 * 校验配置能否真的发出去。
 * @param {ReturnType<typeof normalizeNotifyConfig>} config
 * @returns {{ mode: 'webhook' | 'app' | 'none', error?: string }}
 */
export function notifyMode(config) {
  if (config.webhook.length > 0) {
    let url;
    try {
      url = new URL(config.webhook);
    } catch {
      return { mode: 'webhook', error: '企业微信 Webhook 地址格式不正确' };
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return { mode: 'webhook', error: '企业微信 Webhook 必须是 http(s) 地址' };
    }
    return { mode: 'webhook' };
  }
  if (config.corpId.length > 0 && config.secret.length > 0 && config.agentId.length > 0) {
    if (!/^\d+$/u.test(config.agentId)) return { mode: 'app', error: '企业微信应用 AgentId 必须是数字' };
    return { mode: 'app' };
  }
  return { mode: 'none' };
}

/**
 * 日志/状态里用的掩码：保留开头结尾，中间打码。
 * @param {string} value
 * @returns {string}
 */
export function maskSecret(value) {
  if (typeof value !== 'string' || value.length === 0) return '';
  if (value.length <= 10) return '***';
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/**
 * 去掉 URL 里的访问令牌（用于 `withToken: false`）。
 * @param {string} url
 * @returns {string}
 */
function stripToken(url) {
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete('token');
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * 截断到企业微信能接受的长度。
 * @param {string} text
 * @returns {string}
 */
function truncate(text) {
  if (text.length <= MAX_CONTENT_CHARS) return text;
  return `${text.slice(0, MAX_CONTENT_CHARS - 1)}…`;
}

/**
 * 群机器人用的 markdown 正文。
 * @param {ReturnType<typeof normalizeNotifyConfig>} config
 * @param {{ title: string, lines?: string[], url?: string }} message
 * @returns {string}
 */
function buildMarkdown(config, message) {
  const parts = [`**${message.title}**`];
  for (const line of message.lines ?? []) parts.push(`> ${line}`);
  if (typeof message.url === 'string' && message.url.length > 0) {
    const target = config.withToken ? message.url : stripToken(message.url);
    parts.push(`[${target}](${target})`);
  }
  return truncate(parts.join('\n'));
}

/**
 * 应用消息用的纯文本正文。
 * @param {ReturnType<typeof normalizeNotifyConfig>} config
 * @param {{ title: string, lines?: string[], url?: string }} message
 * @returns {string}
 */
function buildPlain(config, message) {
  const parts = [message.title];
  for (const line of message.lines ?? []) parts.push(line);
  if (typeof message.url === 'string' && message.url.length > 0) {
    parts.push(config.withToken ? message.url : stripToken(message.url));
  }
  return truncate(parts.join('\n'));
}

/**
 * 企业微信推送器。配置通过 `setConfig` 注入，发送失败只返回结果不抛错。
 */
export class WecomNotifier {
  /**
   * @param {{ log?: (message: string) => void }} [options]
   */
  constructor(options = {}) {
    this.log = options.log ?? (() => {});
    this.config = normalizeNotifyConfig(undefined);
    this.token = { value: undefined, expiresAt: 0 };
    this.lastResult = undefined;
    /** 最近一次「阻塞型交互」推送结果，与公网地址推送的状态分开。 */
    this.lastInteractionResult = undefined;
    /** 最近一次「任务完成」推送结果，与公网地址/交互推送的状态分开。 */
    this.lastCompleteResult = undefined;
  }

  /**
   * 更新配置（会清掉缓存的 access_token）。
   * @param {unknown} raw
   * @returns {object} 新的状态描述
   */
  setConfig(raw) {
    this.config = normalizeNotifyConfig(raw);
    this.token = { value: undefined, expiresAt: 0 };
    return this.describe();
  }

  /** 是否具备发送条件。 */
  get configured() {
    return notifyMode(this.config).mode !== 'none';
  }

  /**
   * 给面板/状态用的描述。`secret` 只回 `secretSet`，Webhook 回原值以便编辑
   * （它只在本机回环面板和带令牌的手机接口里出现）。
   * @returns {object}
   */
  describe() {
    const config = this.config;
    const mode = notifyMode(config);
    return {
      enabled: config.enabled === true,
      configured: mode.mode !== 'none',
      mode: mode.mode,
      webhook: config.webhook,
      webhookMasked: maskSecret(config.webhook),
      corpId: config.corpId,
      agentId: config.agentId,
      toUser: config.toUser,
      secretSet: config.secret.length > 0,
      withToken: config.withToken,
      notifyApprovals: config.notifyApprovals === true,
      notifyQuestions: config.notifyQuestions === true,
      notifyComplete: config.notifyComplete === true,
      notifySelfHosted: config.notifySelfHosted === true,
      lastResult: this.lastResult ?? null,
      lastInteractionResult: this.lastInteractionResult ?? null,
      lastCompleteResult: this.lastCompleteResult ?? null,
    };
  }

  /**
   * 发送一条消息（公网地址/测试推送用）。
   * @param {{ title: string, lines?: string[], url?: string }} message
   * @param {string | undefined} [provider] 当前公网通道，用于自建服务器判断。
   * @returns {Promise<{ ok: boolean, skipped?: boolean, error?: string, at: number }>}
   */
  async send(message, provider) {
    const at = Date.now();
    const gate = gateProvider(this.config, provider);
    if (!gate.ok) {
      return this.#record({ ok: false, skipped: true, error: gate.error, at });
    }
    return this.#record(await this.#dispatch(message, at));
  }

  /**
   * 推送一次「阻塞型交互」事件（工具审批 / 用户提问）。
   * 除了总开关 enabled，还要求对应类别的独立开关打开；两者任一关闭都跳过。
   * 结果写进独立的 `lastInteractionResult`，不覆盖公网地址的 `lastResult`。
   * @param {'approval' | 'question'} kind
   * @param {{ title: string, lines?: string[], url?: string }} message
   * @param {string | undefined} [provider] 当前公网通道，用于自建服务器判断。
   * @returns {Promise<{ ok: boolean, skipped?: boolean, error?: string, at: number }>}
   */
  async sendInteraction(kind, message, provider) {
    const config = this.config;
    const at = Date.now();
    const gate = gateProvider(config, provider);
    if (!gate.ok) {
      return this.#recordInteraction({ ok: false, skipped: true, error: gate.error, at });
    }
    const allowed = kind === 'approval' ? config.notifyApprovals : config.notifyQuestions;
    if (allowed !== true) {
      return this.#recordInteraction({ ok: false, skipped: true, error: '此类交互推送已关闭', at });
    }
    return this.#recordInteraction(await this.#dispatch(message, at));
  }

  /**
   * 推送一次「任务完成」事件（会话从 running 回到 idle）。
   * 除了总开关 enabled，还要求 notifyComplete 打开；关闭时只跳过推送，不影响会话。
   * 结果写进独立的 `lastCompleteResult`，不覆盖公网地址与交互推送的状态。
   * @param {{ title: string, lines?: string[], url?: string }} message
   * @param {string | undefined} [provider] 当前公网通道，用于自建服务器判断。
   * @returns {Promise<{ ok: boolean, skipped?: boolean, error?: string, at: number }>}
   */
  async sendComplete(message, provider) {
    const config = this.config;
    const at = Date.now();
    const gate = gateProvider(config, provider);
    if (!gate.ok) {
      return this.#recordComplete({ ok: false, skipped: true, error: gate.error, at });
    }
    if (config.notifyComplete !== true) {
      return this.#recordComplete({ ok: false, skipped: true, error: '任务完成推送已关闭', at });
    }
    return this.#recordComplete(await this.#dispatch(message, at));
  }

  /**
   * 实际发送逻辑（不带状态记录）。
   * @param {{ title: string, lines?: string[], url?: string }} message
   * @param {number} at
   * @returns {Promise<{ ok: boolean, skipped?: boolean, error?: string, at: number }>}
   */
  async #dispatch(message, at) {
    const config = this.config;
    const mode = notifyMode(config);
    if (mode.mode === 'none') {
      return { ok: false, skipped: true, error: '还没有配置企业微信 Webhook', at };
    }
    if (mode.error !== undefined) {
      return { ok: false, error: mode.error, at };
    }
    try {
      if (mode.mode === 'webhook') await this.#postWebhook(buildMarkdown(config, message));
      else await this.#postApp(buildPlain(config, message));
      this.log('pocket: 企业微信推送成功');
      return { ok: true, at };
    } catch (error) {
      const reason = String(error?.message ?? error);
      this.log(`pocket: 企业微信推送失败：${reason}`);
      return { ok: false, error: reason, at };
    }
  }

  /**
   * 记录并返回一次发送结果。
   * @param {{ ok: boolean, skipped?: boolean, error?: string, at: number }} result
   * @returns {{ ok: boolean, skipped?: boolean, error?: string, at: number }}
   */
  #record(result) {
    this.lastResult = {
      ok: result.ok === true,
      at: result.at,
      ...(result.error === undefined ? {} : { error: result.error }),
      ...(result.skipped === true ? { skipped: true } : {}),
    };
    return this.lastResult;
  }

  /**
   * 记录一次阻塞型交互推送结果（独立字段，不影响公网地址状态）。
   * @param {{ ok: boolean, skipped?: boolean, error?: string, at: number }} result
   * @returns {{ ok: boolean, skipped?: boolean, error?: string, at: number }}
   */
  #recordInteraction(result) {
    this.lastInteractionResult = {
      ok: result.ok === true,
      at: result.at,
      ...(result.error === undefined ? {} : { error: result.error }),
      ...(result.skipped === true ? { skipped: true } : {}),
    };
    return this.lastInteractionResult;
  }

  /**
   * 记录一次任务完成推送结果（独立字段，不影响其它推送状态）。
   * @param {{ ok: boolean, skipped?: boolean, error?: string, at: number }} result
   * @returns {{ ok: boolean, skipped?: boolean, error?: string, at: number }}
   */
  #recordComplete(result) {
    this.lastCompleteResult = {
      ok: result.ok === true,
      at: result.at,
      ...(result.error === undefined ? {} : { error: result.error }),
      ...(result.skipped === true ? { skipped: true } : {}),
    };
    return this.lastCompleteResult;
  }

  /**
   * 群机器人 markdown 消息。
   * @param {string} content
   * @returns {Promise<void>}
   */
  async #postWebhook(content) {
    const payload = await this.#request(this.config.webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { content } }),
    });
    this.#assertOk(payload, '群机器人');
  }

  /**
   * 企业应用消息（text），令牌失效时刷新后重试一次。
   * @param {string} content
   * @returns {Promise<void>}
   */
  async #postApp(content) {
    const send = async () => {
      const token = await this.#accessToken();
      return this.#request(`${MESSAGE_ENDPOINT}?access_token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          touser: this.config.toUser,
          msgtype: 'text',
          agentid: Number(this.config.agentId),
          text: { content },
          safe: 0,
        }),
      });
    };
    let payload = await send();
    if (payload.errcode === 40014 || payload.errcode === 42001) {
      this.token = { value: undefined, expiresAt: 0 };
      payload = await send();
    }
    this.#assertOk(payload, '应用消息');
  }

  /**
   * 换 access_token（带缓存）。
   * @returns {Promise<string>}
   */
  async #accessToken() {
    const now = Date.now();
    if (this.token.value !== undefined && now < this.token.expiresAt) return this.token.value;
    const url = `${TOKEN_ENDPOINT}?corpid=${encodeURIComponent(this.config.corpId)}`
      + `&corpsecret=${encodeURIComponent(this.config.secret)}`;
    const payload = await this.#request(url, { method: 'GET' });
    if (payload.errcode !== 0 || typeof payload.access_token !== 'string') {
      throw new Error(`获取企业微信 access_token 失败：${payload.errmsg ?? payload.errcode ?? '未知错误'}`);
    }
    const ttl = Number(payload.expires_in) > 0 ? Number(payload.expires_in) * 1000 : 7_200_000;
    this.token = {
      value: payload.access_token,
      expiresAt: now + Math.max(60_000, ttl - TOKEN_MARGIN_MS),
    };
    return this.token.value;
  }

  /**
   * 发一个 JSON 请求并解析响应。
   * @param {string} url
   * @param {RequestInit} init
   * @returns {Promise<any>}
   */
  async #request(url, init) {
    let response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
      throw new Error(`企业微信请求失败：${error?.name === 'TimeoutError' ? '超时' : String(error?.message ?? error)}`);
    }
    const text = await response.text().catch(() => '');
    if (!response.ok) throw new Error(`企业微信返回 HTTP ${response.status}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`企业微信返回了无法解析的内容（${text.slice(0, 120)}）`);
    }
  }

  /**
   * 企业微信业务错误码检查。
   * @param {any} payload
   * @param {string} label
   * @returns {void}
   */
  #assertOk(payload, label) {
    if (payload === null || typeof payload !== 'object') throw new Error(`${label}返回了空响应`);
    if (payload.errcode === 0) return;
    throw new Error(`${label}发送失败：${payload.errmsg ?? payload.errcode}`);
  }
}

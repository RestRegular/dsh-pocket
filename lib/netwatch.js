/**
 * dsh-pocket — 网络可达性探测。
 *
 * 断网恢复后 Cloudflare Quick Tunnel 不会自己换新地址：旧的 cloudflared
 * 连接通常已经半死，公网域名继续返回错误页。所以插件必须自己判断“网络
 * 回来了”，再把隧道重建一次。
 *
 * 探测方式是纯 TCP 连接（不要求对端返回内容），对 DNS、路由和出口封锁都
 * 敏感，也不受 HTTP 代理环境变量影响。多个目标里任意一个连通就算在线：
 * 国内公共 DNS、Cloudflare、以及一个常见域名（顺带验证 DNS 解析）。
 *
 * @module dsh-pocket/netwatch
 */

import { connect } from 'node:net';

/** 默认在线时的探测间隔。 */
const ONLINE_INTERVAL_MS = 15_000;

/** 默认离线时的探测间隔；断网期间用更短的间隔以便尽快发现恢复。 */
const OFFLINE_INTERVAL_MS = 5_000;

/** 单个 TCP 探测的超时。 */
const PROBE_TIMEOUT_MS = 4_000;

/** 探测目标：任意一个连通即视为在线。 */
const PROBE_TARGETS = Object.freeze([
  { host: '223.5.5.5', port: 443 },
  { host: '1.1.1.1', port: 443 },
  { host: 'www.baidu.com', port: 443 },
]);

/**
 * 尝试一次 TCP 连接。
 * @param {string} host
 * @param {number} port
 * @param {number} timeout
 * @param {AbortSignal} [signal]
 * @returns {Promise<boolean>}
 */
function tcpProbe(host, port, timeout, signal) {
  return new Promise((resolvePromise) => {
    if (signal?.aborted === true) {
      resolvePromise(false);
      return;
    }
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      try {
        socket.destroy();
      } catch {
        /* 已经关闭 */
      }
      resolvePromise(value);
    };
    const onAbort = () => finish(false);
    const socket = connect({ host, port });
    socket.setTimeout(timeout, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('close', () => finish(false));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 并行探测全部目标；**任一成功就立刻返回 true**，不用等其它目标超时。
 * 这很重要：网络正常时探测应在几十毫秒内返回，否则断网恢复的检测会拖到
 * 一个探测周期之后。
 * @param {number} timeout
 * @param {AbortSignal} [signal]
 * @returns {Promise<boolean>}
 */
function probeAll(timeout, signal) {
  return new Promise((resolvePromise) => {
    let pending = PROBE_TARGETS.length;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    for (const target of PROBE_TARGETS) {
      void tcpProbe(target.host, target.port, timeout, signal).then((ok) => {
        if (ok) {
          finish(true);
          return;
        }
        pending -= 1;
        if (pending === 0) finish(false);
      });
    }
    if (signal?.aborted === true) finish(false);
  });
}

/**
 * 网络状态观察器。只在状态发生翻转时回调，避免每次探测都打扰调用方。
 */
export class NetworkWatch {
  /**
   * @param {{
   *   interval?: number,
   *   offlineInterval?: number,
   *   timeout?: number,
   *   onOnline?: () => void,
   *   onOffline?: () => void,
   *   onTick?: (online: boolean) => void,
   *   log?: (message: string) => void,
   *   probe?: () => Promise<boolean>,
   * }} [options]
   */
  constructor(options = {}) {
    this.interval = options.interval ?? ONLINE_INTERVAL_MS;
    this.offlineInterval = options.offlineInterval ?? OFFLINE_INTERVAL_MS;
    this.timeout = options.timeout ?? PROBE_TIMEOUT_MS;
    this.onOnline = options.onOnline;
    this.onOffline = options.onOffline;
    this.onTick = options.onTick;
    this.log = options.log ?? (() => {});
    /** 可注入的探测函数（测试用）。 */
    this.probe = options.probe ?? (() => probeAll(this.timeout, this.abort.signal));
    /** `undefined` 表示还没有完成第一次探测。 */
    this.online = undefined;
    this.checkedAt = undefined;
    this.lastChangeAt = undefined;
    this.timer = undefined;
    this.stopped = true;
    /** 停止时用它中断在途探测，避免 socket 悬着让进程退出卡住。 */
    this.abort = new AbortController();
  }

  /** 状态快照。 */
  status() {
    return {
      online: this.online,
      checkedAt: this.checkedAt ?? null,
      lastChangeAt: this.lastChangeAt ?? null,
    };
  }

  /** 开始观察（幂等）。 */
  start() {
    if (this.stopped === false) return;
    this.stopped = false;
    this.abort = new AbortController();
    void this.#run();
  }

  /** 停止观察、清掉定时器并中断在途探测。 */
  stop() {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    try {
      this.abort.abort();
    } catch {
      /* 已经中断 */
    }
  }

  async #run() {
    if (this.stopped) return;
    let online = false;
    try {
      online = await this.probe();
    } catch {
      online = false;
    }
    if (this.stopped) return;
    const previous = this.online;
    this.online = online;
    this.checkedAt = Date.now();
    if (previous !== online) {
      this.lastChangeAt = this.checkedAt;
      if (previous !== undefined) {
        this.log(`pocket: network ${online ? 'online' : 'offline'}`);
        try {
          if (online) this.onOnline?.();
          else this.onOffline?.();
        } catch (error) {
          this.log(`pocket: network callback failed: ${error?.message ?? error}`);
        }
      } else if (online === false) {
        // 启动时就是离线：也要通知一次，让上层知道现在的隧道注定建不起来。
        this.log('pocket: network offline at startup');
        try {
          this.onOffline?.();
        } catch {
          /* ignore */
        }
      }
    }
    // 每次探测都回调一次，上层可以借此确认“隧道还活着”。
    try {
      this.onTick?.(online);
    } catch {
      /* ignore */
    }
    const delay = online ? this.interval : this.offlineInterval;
    this.timer = setTimeout(() => {
      void this.#run();
    }, delay);
    this.timer.unref?.();
  }
}

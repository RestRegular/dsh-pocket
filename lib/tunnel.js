/**
 * dsh-pocket — 隧道管理。
 *
 * 目标只有一个：把本机的移动端端口映射成一个公网 HTTPS 地址。这里不绑定
 * 任何云厂商，按可用性依次尝试几条常见路径：
 *
 *   cloudflared   `cloudflared tunnel --url …`（Quick Tunnel，无需账号）
 *   localtunnel   `lt --port …`（npm 包，无需账号）
 *   localhost.run `ssh -R 80:127.0.0.1:PORT nokey@localhost.run`
 *   custom        用户自定义命令，输出里出现第一个 https URL 即视为就绪
 *
 * 所有子进程都是本插件自己拉起、自己回收；不依赖 DSH 的 subprocess 服务，
 * 因为隧道进程需要在整个 Host 生命周期里常驻，而不是随某一次工具调用结束。
 *
 * @module dsh-pocket/tunnel
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, platform } from 'node:os';

const require = createRequire(import.meta.url);

/** 缓存平台自带二进制路径的解析结果。 */
let bundledCloudflaredPath;

/**
 * 找不到系统 cloudflared 时，使用随插件安装的 Windows x64 预编译二进制。
 * 该包只在 win32-x64 上作为可选依赖安装，其他平台返回 undefined。
 * @returns {string | undefined}
 */
function bundledCloudflared() {
  if (platform() !== 'win32' || process.arch !== 'x64') return undefined;
  if (bundledCloudflaredPath !== undefined) return bundledCloudflaredPath;
  try {
    const resolved = require.resolve('agentroam-cloudflared-win32-x64/archive');
    bundledCloudflaredPath = existsSync(resolved) ? resolved : undefined;
  } catch {
    bundledCloudflaredPath = undefined;
  }
  return bundledCloudflaredPath;
}

/** 免费隧道服务真正给出的公网域名；先按白名单匹配，避免把帮助文档里的链接当成隧道地址。 */
const KNOWN_TUNNEL_URL = /https:\/\/[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.(?:trycloudflare\.com|loca\.lt|lhr\.life|localhost\.run|serveo\.net|ngrok\.io|ngrok-free\.app|ngrok-free\.dev|devtunnels\.ms)(?::\d+)?\/?[^\s"'<>]*/u;

/** 自定义命令可能输出任意域名；只排除常见文档站。 */
const GENERIC_URL = /https:\/\/[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+(?::\d+)?\/?[^\s"'<>]*/gu;

/** 不可能是隧道入口的域名。 */
const NOT_TUNNEL = /(?:^|\.)(?:cloudflare\.com|github\.com|npmjs\.com|cloudflare\.dev)$/iu;

/** 允许的隧道模式。 */
export const TUNNEL_MODES = ['auto', 'cloudflared', 'localtunnel', 'localhost.run', 'ssh', 'custom', 'off'];

/** 自动模式下尝试顺序。 */
const AUTO_ORDER = ['cloudflared', 'localtunnel', 'localhost.run'];

/** 单个隧道程序等待公网地址的上限。 */
const READY_TIMEOUT_MS = 30_000;

/**
 * sshd 拒绝反向转发时的报错：服务器上 `127.0.0.1:sshRemotePort` 已被占用。
 * 最常见的原因是上一条 SSH 会话还没被服务端回收（本机崩溃 / 休眠 / 切换网络后
 * 服务端察觉不到半开连接），sshd 会一直占着那个监听端口。
 */
const SSH_FORWARD_CONFLICT = /remote port forwarding failed|address already in use|cannot listen to (?:remote )?port/iu;

/** 端口被占用时，换用这个区间里随机的回环端口继续尝试。 */
const FALLBACK_REMOTE_PORT_MIN = 20_000;
const FALLBACK_REMOTE_PORT_MAX = 60_000;

/**
 * 判断一次失败是否属于“远程转发端口被占用”。
 * @param {unknown} error
 * @returns {boolean}
 */
function isForwardConflict(error) {
  return SSH_FORWARD_CONFLICT.test(error instanceof Error ? error.message : String(error));
}

/**
 * 挑一个还没试过的随机回环端口，避免再次撞上旧会话。
 * @param {Set<number>} taken
 * @returns {number}
 */
function randomRemotePort(taken) {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const port = FALLBACK_REMOTE_PORT_MIN
      + Math.floor(Math.random() * (FALLBACK_REMOTE_PORT_MAX - FALLBACK_REMOTE_PORT_MIN));
    if (!taken.has(port)) return port;
  }
  return FALLBACK_REMOTE_PORT_MIN + (taken.size % (FALLBACK_REMOTE_PORT_MAX - FALLBACK_REMOTE_PORT_MIN));
}

/** 保留多少行输出用于面板排错。 */
const LOG_TAIL_LINES = 6;

/**
 * 给 shell 包装一个参数（Windows cmd 与 POSIX 都只需要处理双引号）。
 * @param {string} value
 * @returns {string}
 */
function quote(value) {
  if (!/[\s"&|<>^]/u.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * 在 PATH 里解析命令，尽量拿到可直接执行的绝对路径。
 * Windows 上跳过 `.ps1`（cmd.exe 不能直接执行 PowerShell 脚本）。
 * @param {string} command
 * @returns {string | undefined}
 */
export function resolveCommand(command) {
  if (command.includes('/') || command.includes('\\')) {
    return existsSync(command) ? command : undefined;
  }
  const isWindows = platform() === 'win32';
  try {
    const result = isWindows
      ? spawnSync('where.exe', [command], { encoding: 'utf8', windowsHide: true })
      : spawnSync('sh', ['-c', `command -v ${command}`], { encoding: 'utf8' });
    if (result.status !== 0 || typeof result.stdout !== 'string') return undefined;
    const candidates = result.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => {
        if (line.length === 0) return false;
        const lower = line.toLowerCase();
        if (lower.endsWith('.ps1')) return false;
        // Windows 的 `where` 会先列出无扩展名的 shell 脚本；它们不能直接被
        // node 的 spawn 执行，必须让 cmd.exe 代跑，所以优先挑选可执行包装。
        if (isWindows) return /\.(exe|cmd|bat|com)$/u.test(lower);
        return true;
      })
      .sort((left, right) => {
        const rank = (value) => (/\.exe$/iu.test(value) ? 0 : /\.(cmd|bat)$/iu.test(value) ? 1 : 2);
        return rank(left) - rank(right);
      });
    return candidates[0];
  } catch {
    return undefined;
  }
}

/**
 * 等待若干毫秒；用于端口释放的短暂竞态。
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 从一段输出中找第一个公网 URL。
 * @param {string} text
 * @param {string} [provider]
 * @returns {string | undefined}
 */
export function extractUrl(text, provider) {
  const known = KNOWN_TUNNEL_URL.exec(text);
  if (known !== null) return known[0].replace(/[.,;:]+$/u, '');
  if (provider !== 'custom') return undefined;
  GENERIC_URL.lastIndex = 0;
  let match;
  while ((match = GENERIC_URL.exec(text)) !== null) {
    const url = match[0].replace(/[.,;:]+$/u, '');
    try {
      if (!NOT_TUNNEL.test(new URL(url).hostname)) return url;
    } catch {
      /* 忽略畸形 URL */
    }
  }
  return undefined;
}

/**
 * 把 IPv6 主机名放进 URL 的方括号里。
 * @param {string} host
 * @returns {string}
 */
function urlHost(host) {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/**
 * 展开 SSH 私钥路径里的 `~`；spawn 不会做 shell 展开。
 * @param {string | undefined} value
 * @returns {string | undefined}
 */
function expandHome(value) {
  if (value === undefined || value.length === 0) return undefined;
  return value.replace(/^~(?=$|[\\/])/u, homedir());
}

/**
 * 自有服务器模式：本地通过 SSH 反向端口转发到服务器 127.0.0.1，
 * 再由服务器上的一个小 Node TCP 代理监听公网端口，转发到该回环端口。
 * 这样不要求服务器开启 GatewayPorts，也不用改 sshd 配置。
 * @param {number} remotePort
 * @param {number} exposePort
 * @param {string} exposeHost
 * @returns {string}
 */
function sshRelayCommand(remotePort, exposePort, exposeHost) {
  const script = [
    "const net=require('net');",
    `const server=net.createServer((s)=>{const t=net.connect(${remotePort},'127.0.0.1');s.pipe(t).pipe(s);s.on('error',()=>t.destroy());t.on('error',()=>s.destroy());});`,
    `server.listen(${exposePort},'${exposeHost}',()=>console.log('POCKET_RELAY_READY'));`,
    "process.on('SIGHUP',()=>process.exit(0));",
    "process.on('SIGTERM',()=>process.exit(0));",
    "process.stdin.resume();",
    "process.stdin.on('end',()=>process.exit(0));",
    "process.stdin.on('close',()=>process.exit(0));",
  ].join('');
  return `node -e "${script}"`;
}

/**
 * 每个提供方的启动参数。
 * @param {string} provider
 * @param {number} port
 * @param {{
 *   cloudflaredPath?: string,
 *   customCommand?: string,
 *   sshHost?: string,
 *   sshUser?: string,
 *   sshPort?: number,
 *   sshKeyPath?: string,
 *   sshRemotePort?: number,
 *   sshExposePort?: number,
 *   sshExposeHost?: string,
 *   sshPublicUrl?: string,
 * }} options
 * @returns {{ command: string, args: string[], shell: boolean, url?: string, readyMarker?: string, keepStdin?: boolean } | undefined}
 */
function commandFor(provider, port, options) {
  switch (provider) {
    case 'cloudflared': {
      const command = options.cloudflaredPath?.trim() || bundledCloudflared() || 'cloudflared';
      return {
        command,
        args: ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'],
        shell: false,
      };
    }
    case 'localtunnel':
      return { command: 'lt', args: ['--port', String(port)], shell: false };
    case 'localhost.run':
      return {
        command: 'ssh',
        args: [
          '-o', 'StrictHostKeyChecking=no',
          '-o', 'ServerAliveInterval=30',
          '-o', 'ExitOnForwardFailure=yes',
          '-R', `80:127.0.0.1:${port}`,
          'nokey@localhost.run',
        ],
        shell: false,
      };
    case 'ssh': {
      const host = options.sshHost?.trim();
      if (host === undefined || host.length === 0) throw new Error('缺少 sshHost');
      const remotePort = options.sshRemotePort ?? 8790;
      const exposePort = options.sshExposePort ?? 80;
      const exposeHost = options.sshExposeHost?.trim() || '0.0.0.0';
      const sshPort = options.sshPort ?? 22;
      const user = options.sshUser?.trim();
      const target = user !== undefined && user.length > 0 && !host.includes('@') ? `${user}@${host}` : host;
      const key = expandHome(options.sshKeyPath?.trim());
      const args = [
        '-T',
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=10',
        '-o', 'ServerAliveInterval=30',
        '-o', 'ServerAliveCountMax=3',
        '-o', 'ExitOnForwardFailure=yes',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-p', String(sshPort),
        '-R', `127.0.0.1:${remotePort}:127.0.0.1:${port}`,
      ];
      if (key !== undefined) args.push('-i', key, '-o', 'IdentitiesOnly=yes');
      args.push(target, sshRelayCommand(remotePort, exposePort, exposeHost));
      const configured = options.sshPublicUrl?.trim();
      const authority = exposePort === 80 ? urlHost(host) : `${urlHost(host)}:${exposePort}`;
      const url = configured !== undefined && configured.length > 0
        ? configured.replace(/\/+$/u, '')
        : `http://${authority}`;
      return {
        command: 'ssh',
        args,
        shell: false,
        url,
        readyMarker: 'POCKET_RELAY_READY',
        keepStdin: true,
      };
    }
    case 'custom': {
      const template = options.customCommand?.trim();
      if (template === undefined || template.length === 0) return undefined;
      const line = template
        .replaceAll('%PORT%', String(port))
        .replaceAll('{port}', String(port));
      return { command: line, args: [], shell: true };
    }
    default:
      return undefined;
  }
}

/**
 * 一个可启停的隧道。同一时刻最多一条。
 */
export class TunnelManager {
  /**
   * @param {{
   *   port: number,
   *   mode: string,
   *   cloudflaredPath?: string,
   *   customCommand?: string,
   *   publicUrl?: string,
   *   sshHost?: string,
   *   sshUser?: string,
   *   sshPort?: number,
   *   sshKeyPath?: string,
   *   sshRemotePort?: number,
   *   sshExposePort?: number,
   *   sshExposeHost?: string,
   *   sshPublicUrl?: string,
   *   onStatus?: (status: object) => void,
   *   log?: (message: string) => void,
   * }} options
   */
  constructor(options) {
    this.options = options;
    this.child = undefined;
    this.generation = 0;
    this.logTail = [];
    this.status = {
      state: 'off',
      provider: undefined,
      url: undefined,
      error: undefined,
      startedAt: undefined,
    };
  }

  /** 当前状态快照。 */
  snapshot() {
    return {
      ...this.status,
      log: [...this.logTail],
      mode: this.options.mode,
      sshHost: this.options.sshHost,
    };
  }

  /**
   * 更新状态并通知观察者。
   * @param {Partial<typeof this.status>} patch
   */
  setStatus(patch) {
    this.status = { ...this.status, ...patch };
    try {
      this.options.onStatus?.(this.snapshot());
    } catch {
      /* 观察者异常不能影响隧道本身 */
    }
  }

  /**
   * 追加一行输出到环形日志。
   * @param {string} line
   */
  pushLog(line) {
    const clean = line.replace(/\u001b\[[0-9;]*m/gu, '').trimEnd();
    if (clean.length === 0) return;
    this.logTail.push(clean.length > 300 ? `${clean.slice(0, 300)}…` : clean);
    if (this.logTail.length > LOG_TAIL_LINES) this.logTail.shift();
  }

  /** 停止当前隧道。 */
  stop() {
    this.generation += 1;
    const child = this.child;
    this.child = undefined;
    if (child !== undefined && child.exitCode === null && !child.killed) {
      const keepStdin = this.childKeepsStdin === true;
      this.childKeepsStdin = false;
      try {
        if (keepStdin && child.stdin !== null && child.stdin.writable) {
          // 关掉远端 relay 的标准输入让它先自行退出，sshd 会立刻释放反向转发端口。
          // 残留的半开连接正是下次启动报“remote port forwarding failed”的根源。
          child.stdin.end();
          const timer = setTimeout(() => {
            try {
              child.kill();
            } catch {
              /* 进程可能已经退出 */
            }
          }, 500);
          timer.unref?.();
        } else {
          child.kill();
        }
      } catch {
        /* 进程可能已经退出 */
      }
    }
    this.logTail = [];
    this.setStatus({
      state: 'off',
      provider: undefined,
      url: undefined,
      error: undefined,
      startedAt: undefined,
    });
  }

  /**
   * 启动隧道。`auto` 会依次尝试直到拿到地址。
   * @returns {Promise<object>} 最终状态快照
   */
  async start() {
    this.stop();
    const generation = this.generation;
    const mode = this.options.mode;

    if (mode === 'off') {
      this.setStatus({ state: 'off', error: undefined });
      return this.snapshot();
    }

    const manual = this.options.publicUrl?.trim();
    if (manual !== undefined && manual.length > 0) {
      this.setStatus({
        state: 'online',
        provider: 'manual',
        url: manual.replace(/\/+$/u, ''),
        error: undefined,
        startedAt: Date.now(),
      });
      return this.snapshot();
    }

    const sshHost = this.options.sshHost?.trim();
    const candidates = mode === 'auto'
      ? (sshHost !== undefined && sshHost.length > 0
          ? ['cloudflared', 'ssh', 'localtunnel', 'localhost.run']
          : [...AUTO_ORDER])
      : [mode];
    const failures = [];
    for (const provider of candidates) {
      if (generation !== this.generation) return this.snapshot();
      try {
        const url = provider === 'ssh'
          ? await this.#attemptSsh(generation)
          : await this.#attempt(provider, generation);
        if (url !== undefined) return this.snapshot();
      } catch (error) {
        failures.push(`${provider}: ${String(error?.message ?? error)}`);
        this.pushLog(`[${provider}] ${String(error?.message ?? error)}`);
      }
    }

    if (generation === this.generation) {
      const error = failures.length > 0 ? failures.join('；') : '没有可用的隧道程序';
      this.setStatus({ state: 'error', provider: undefined, url: undefined, error });
    }
    return this.snapshot();
  }

  /**
   * SSH 模式启动。服务器上的 `127.0.0.1:sshRemotePort` 经常被上一条 SSH
   * 会话占着（本机崩溃、休眠、换网络后服务端察觉不到半开连接），sshd 会在
   * 转发建立阶段直接报 `remote port forwarding failed for listen port …`。
   * 这里先在原端口上快速重试一次（覆盖“刚断开、端口正在释放”的窗口），
   * 仍冲突就换随机的回环端口——该端口只在服务器回环上使用，不对外暴露。
   * @param {number} generation
   * @returns {Promise<string | undefined>}
   */
  async #attemptSsh(generation) {
    const configured = this.options.sshRemotePort ?? 8790;
    const taken = new Set([configured]);
    const ports = [configured, configured];
    // 最多再换两个随机端口；端口冲突是启动瞬间就返回的，不会叠加 30 秒超时。
    while (ports.length < 4) {
      const next = randomRemotePort(taken);
      taken.add(next);
      ports.push(next);
    }

    let lastError;
    for (let index = 0; index < ports.length; index += 1) {
      if (generation !== this.generation) return undefined;
      const port = ports[index];
      if (index > 0) {
        this.pushLog(port === configured
          ? `[ssh] 127.0.0.1:${port} 被占用，稍等后重试`
          : `[ssh] 127.0.0.1:${configured} 被占用，改用 ${port} 重试`);
      }
      try {
        const url = await this.#attempt('ssh', generation, port);
        if (url !== undefined) return url;
      } catch (error) {
        lastError = error;
        if (!isForwardConflict(error)) throw error;
        // 上一条连接刚结束时端口通常很快释放，先等一会儿再试同一个端口。
        if (index === 0) await sleep(800);
      }
    }

    const reason = String(lastError?.message ?? lastError ?? '未知错误');
    throw new Error(
      `SSH 反向转发端口不可用（${[...new Set(ports)].join('、')} 均被占用），`
      + `服务器上可能还有未释放的旧会话：${reason}`,
    );
  }

  /**
   * 尝试一个提供方，直到拿到 URL、进程退出或超时。
   * @param {string} provider
   * @param {number} generation
   * @param {number} [remotePort] 覆盖本次使用的远程回环端口（仅 ssh 模式）
   * @returns {Promise<string | undefined>}
   */
  #attempt(provider, generation, remotePort) {
    const options = remotePort === undefined ? this.options : { ...this.options, sshRemotePort: remotePort };
    const spec = commandFor(provider, this.options.port, options);
    if (spec === undefined) throw new Error('缺少启动命令');

    let command = spec.command;
    let useShell = spec.shell;
    if (!useShell) {
      const resolved = resolveCommand(command);
      if (resolved === undefined) throw new Error(`未找到 ${command}`);
      command = resolved;
      // .cmd / .bat 包装器需要 cmd.exe 代跑，否则 spawn 会直接 ENOENT。
      useShell = /\.(cmd|bat)$/iu.test(command);
    }

    const line = useShell && !spec.shell
      ? [quote(command), ...spec.args.map(quote)].join(' ')
      : command;
    this.setStatus({ state: 'starting', provider, url: undefined, error: undefined });

    return new Promise((resolve, reject) => {
      let settled = false;
      let output = '';
      let timer;

      const child = spawn(useShell ? line : command, useShell ? [] : spec.args, {
        shell: useShell,
        windowsHide: true,
        stdio: [spec.keepStdin === true ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        env: process.env,
        detached: false,
      });
      this.child = child;
      this.childKeepsStdin = spec.keepStdin === true;

      const finish = (error, url) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (url !== undefined) {
          resolve(url);
          return;
        }
        reject(error ?? new Error('隧道进程结束但没有输出地址'));
      };

      const onData = (chunk) => {
        const text = String(chunk);
        output += text;
        if (output.length > 32_000) output = output.slice(-16_000);
        for (const raw of text.split(/\r?\n/u)) this.pushLog(raw);
        const url = spec.readyMarker !== undefined && text.includes(spec.readyMarker)
          ? spec.url
          : extractUrl(text, provider);
        if (url !== undefined && !settled) {
          this.setStatus({
            state: 'online',
            provider,
            url,
            error: undefined,
            startedAt: Date.now(),
            ...(remotePort !== undefined ? { remotePort } : {}),
          });
          this.options.log?.(`pocket: tunnel online (${provider}) ${url}`);
          finish(undefined, url);
        }
      };

      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);

      child.once('error', (error) => {
        this.pushLog(`[${provider}] ${error.message}`);
        finish(error);
      });

      child.once('exit', (code, signal) => {
        if (this.child === child) {
          this.child = undefined;
          this.childKeepsStdin = false;
        }
        if (!settled) {
          const tail = this.logTail.slice(-3).join(' / ');
          finish(new Error(`进程已退出（code=${String(code)}, signal=${String(signal)}）${tail.length > 0 ? `：${tail}` : ''}`));
          return;
        }
        if (generation === this.generation && this.status.state === 'online') {
          this.setStatus({
            state: 'error',
            error: `隧道进程已退出（code=${String(code)}）`,
            url: undefined,
          });
        }
      });

      timer = setTimeout(() => {
        if (settled) return;
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        finish(new Error(`${READY_TIMEOUT_MS / 1000} 秒内没有拿到公网地址`));
      }, READY_TIMEOUT_MS);
      timer.unref?.();
    });
  }
}

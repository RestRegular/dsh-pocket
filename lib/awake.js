/**
 * dsh-pocket — 保持电脑常亮（不休眠）。
 *
 * 通过一个长期存活的子进程持有系统“禁止空闲休眠”的断言：
 *
 *   - Windows：PowerShell 调 `SetThreadExecutionState(ES_CONTINUOUS |
 *     ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED)`，线程存活期间系统与屏幕都
 *     不会因空闲关闭；
 *   - macOS：`caffeinate -dimsu -w <宿主 pid>`；
 *   - Linux：`systemd-inhibit --what=idle:sleep … sleep infinity`。
 *
 * 断言随子进程结束而释放，因此 DSH 退出、插件重载或用户关闭开关后，电脑
 * 立即回到原来的电源策略。Windows 的锁屏仍由系统安全策略/屏幕保护决定，
 * 本模块只保证“不熄屏、不睡眠”。
 *
 * 子进程会定期检查宿主进程是否还在；即使宿主被强杀，最迟约 30 秒后也会
 * 自行退出，不会留下永久拒绝睡眠的孤儿进程。
 *
 * @module dsh-pocket/awake
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 等待子进程确认已生效的超时（PowerShell 首次 Add-Type 编译可能较慢）。 */
const READY_TIMEOUT_MS = 15_000;

/** 锁屏无关：只保留诊断用的 stderr 尾部。 */
const STDERR_LIMIT = 4_000;

/**
 * 所有存活的「常亮」子进程。宿主进程退出时兜底回收，避免留下永远阻止
 * 睡眠的孤儿（Windows 上父进程退出不会自动带走子进程）。
 * @type {Set<import('node:child_process').ChildProcess>}
 */
const liveChildren = new Set();

process.once('exit', () => {
  for (const child of liveChildren) {
    try {
      child.kill();
    } catch {
      /* 宿主退出阶段尽力而为 */
    }
  }
});

/**
 * 生成一个错误并附带 code（用于区分 ENOENT 与其它启动失败）。
 * @param {string} message
 * @param {NodeJS.ErrnoException | undefined} cause
 * @returns {Error & { code?: string }}
 */
function spawnError(message, cause) {
  const error = new Error(message);
  if (typeof cause?.code === 'string') error.code = cause.code;
  return error;
}

/**
 * 阻止空闲休眠的管理器。
 */
export class KeepAwake {
  /**
   * @param {(message: string) => void} [log]
   * @param {{ display?: boolean }} [options] - `display: false` 时只阻止系统
   *   睡眠（Windows），屏幕仍可关闭。
   */
  constructor(log, options = {}) {
    this.log = log ?? (() => {});
    this.display = options.display !== false;
    /** 用户/配置期望的状态；`active` 才是真的生效。 */
    this.desired = false;
    /** @type {import('node:child_process').ChildProcess | undefined} */
    this.child = undefined;
    this.startedAt = undefined;
    /** @type {string | undefined} */
    this.error = undefined;
    /** @type {Promise<object> | undefined} */
    this.pending = undefined;
  }

  /** 当前平台是否实现了常亮。 */
  get supported() {
    return process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux';
  }

  /** 断言是否真的由子进程持有。 */
  get active() {
    const child = this.child;
    return child !== undefined
      && this.startedAt !== undefined
      && child.exitCode === null
      && child.signalCode === null;
  }

  /**
   * 给面板/手机的状态快照。
   * @returns {{ supported: boolean, enabled: boolean, active: boolean, since: number | null, error: string | null, platform: string }}
   */
  status() {
    return {
      supported: this.supported,
      enabled: this.desired === true,
      active: this.active,
      since: this.active ? this.startedAt ?? null : null,
      error: this.error ?? null,
      platform: process.platform,
    };
  }

  /**
   * 打开或关闭常亮，返回最新状态。
   * @param {boolean} enabled
   * @returns {Promise<object>}
   */
  async setEnabled(enabled) {
    if (enabled === true) return this.start();
    this.stop();
    return this.status();
  }

  /**
   * 打开常亮（幂等）。启动失败时抛出错误，并把原因留在 `status().error`。
   * @returns {Promise<object>}
   */
  async start() {
    if (this.active) {
      this.desired = true;
      return this.status();
    }
    if (this.pending !== undefined) return this.pending;
    this.desired = true;
    this.error = undefined;
    this.pending = this.#start().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  async #start() {
    try {
      await this.#launch();
      this.startedAt = Date.now();
      return this.status();
    } catch (error) {
      this.desired = false;
      this.error = String(error?.message ?? error);
      this.#dispose();
      throw new Error(this.error);
    }
  }

  /** 关闭常亮并释放断言。 */
  stop() {
    this.desired = false;
    this.error = undefined;
    this.#dispose();
  }

  async #launch() {
    const platform = process.platform;
    if (platform === 'win32') {
      const script = join(HERE, 'awake-win.ps1');
      const args = [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        script,
        '-ParentPid',
        String(process.pid),
        '-Mode',
        this.display ? 'all' : 'system',
      ];
      const ready = (line) => line === 'awake';
      // 优先用 %SystemRoot% 下的绝对路径，PATH 里没有 System32 时也能启动。
      const systemRoot = process.env.SystemRoot ?? process.env.windir;
      const candidates = [
        ...(systemRoot === undefined
          ? []
          : [join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')]),
        'powershell.exe',
        'pwsh.exe',
      ];
      let lastError;
      for (const candidate of candidates) {
        try {
          await this.#spawnAndWait(candidate, args, 'Windows 常亮', ready);
          return;
        } catch (error) {
          lastError = error;
          if (error?.code !== 'ENOENT') throw error;
        }
      }
      throw lastError;
    }

    if (platform === 'darwin') {
      await this.#spawnAndWait(
        'caffeinate',
        [this.display ? '-dimsu' : '-imsu', '-w', String(process.pid)],
        'macOS caffeinate',
        undefined,
      );
      return;
    }

    if (platform === 'linux') {
      // 让 `sh` 循环盯着宿主 pid：DSH 退出后 systemd-inhibit 自行结束，
      // 不会留下一直持有 inhibitor 的孤儿。
      await this.#spawnAndWait(
        'systemd-inhibit',
        [
          '--what=idle:sleep',
          '--who=DSH Pocket',
          '--why=Keep the computer awake while the Pocket mobile session is open',
          'sh',
          '-c',
          `while kill -0 ${process.pid} 2>/dev/null; do sleep 5; done`,
        ],
        'systemd-inhibit',
        undefined,
      );
      return;
    }

    throw new Error(`当前平台（${platform}）不支持保持常亮`);
  }

  /**
   * 启动子进程并等待它报告就绪。
   * @param {string} command
   * @param {string[]} args
   * @param {string} label
   * @param {((line: string) => boolean) | undefined} ready - Windows 用 stdout
   *   的 `awake` 行确认；其它平台传 undefined，spawn 成功后短暂观察再确认。
   * @returns {Promise<void>}
   */
  #spawnAndWait(command, args, label, ready) {
    return new Promise((resolvePromise, rejectPromise) => {
      let child;
      try {
        child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        rejectPromise(spawnError(`无法启动 ${command}：${error?.message ?? error}`, error));
        return;
      }

      liveChildren.add(child);
      this.child = child;
      let settled = false;
      let stderr = '';
      /** @type {NodeJS.Timeout | undefined} */
      let timer;

      const tail = () => {
        const text = stderr.trim();
        return text.length === 0 ? '' : `：${text.slice(-600)}`;
      };

      const finish = (error) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        if (error === undefined) {
          resolvePromise();
          return;
        }
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        rejectPromise(error);
      };

      timer = setTimeout(() => {
        finish(new Error(`${label} 启动超时（${Math.round(READY_TIMEOUT_MS / 1000)} 秒）`));
      }, READY_TIMEOUT_MS);
      timer.unref?.();

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk) => {
        for (const line of String(chunk).split(/\r?\n/u)) {
          const text = line.trim();
          if (text.length === 0) continue;
          if (ready !== undefined && ready(text)) {
            finish(undefined);
            continue;
          }
          if (text.startsWith('error:')) {
            finish(new Error(`${label}：${text.slice('error:'.length).trim()}`));
          }
        }
      });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-STDERR_LIMIT);
      });

      child.on('error', (error) => {
        liveChildren.delete(child);
        if (this.child === child) this.child = undefined;
        finish(spawnError(`无法启动 ${command}：${error.message}`, error));
      });

      child.on('exit', (code, signal) => {
        liveChildren.delete(child);
        if (this.child === child) this.child = undefined;
        this.startedAt = undefined;
        if (!settled) {
          finish(new Error(`${label} 启动失败（${code === null ? signal : `退出码 ${code}`}）${tail()}`));
          return;
        }
        if (this.desired) {
          this.desired = false;
          this.error = `${label} 已退出（${code === null ? signal : `退出码 ${code}`}）${tail()}`;
          this.log(`pocket: keep-awake exited: ${this.error}`);
        }
      });

      if (ready === undefined) {
        // caffeinate / systemd-inhibit 没有就绪行：spawn 后观察一小段时间，
        // 排掉“命令存在但立刻失败”的情况（例如容器里没有 systemd）。
        child.once('spawn', () => {
          const probe = setTimeout(() => {
            if (!settled && child.exitCode === null) finish(undefined);
          }, 700);
          probe.unref?.();
        });
      }
    });
  }

  /** 结束子进程并清理本地状态。 */
  #dispose() {
    this.startedAt = undefined;
    const child = this.child;
    this.child = undefined;
    if (child === undefined) return;
    liveChildren.delete(child);
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }
}

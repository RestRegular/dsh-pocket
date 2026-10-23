/**
 * dsh-pocket — 一键重启 / 关闭 DSH。
 *
 * Pocket 的 Host 跑在 `dsh-desktop-host` 子进程里，宿主只暴露了关闭/更新控制，
 * 没有“重启应用”的 IPC。因此这里用父进程拉起一个脱离的辅助进程
 * （`restart-helper.cjs`）：先等提示信息显示完、HTTP 响应发完 → 结束 Electron
 * 主进程 → 等旧 Host 优雅退出 → 按模式决定是否重新启动同一个可执行文件。
 *
 * 只有桌面版（Electron，Host 是主进程的直接子进程）支持；`dsh web` 这类纯
 * 命令行运行方式会返回明确的“不支持”原因，由界面自行隐藏/提示。
 *
 * @module dsh-pocket/restart
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

/** 辅助进程脚本；随包发布，不需要运行时写文件。 */
const HELPER_PATH = fileURLToPath(new URL('./restart-helper.cjs', import.meta.url));

/** 让界面提示先显示、HTTP 响应先落地的延迟；两种操作共用。 */
const ACTION_DELAY_MS = 1_500;

/** 同一进程只调度一次，避免连点产生多个辅助进程。 */
let scheduled = false;

/**
 * DSH 主目录；与 state.js 保持一致。
 * @returns {string}
 */
function dshHome() {
  const configured = process.env.DSH_HOME;
  if (typeof configured === 'string' && configured.trim().length > 0) return configured.trim();
  return join(homedir(), '.dsh');
}

/**
 * 判断当前运行方式是否支持从 Pocket 控制整个应用。
 * @param {'重启' | '关闭'} verb
 * @returns {{ supported: boolean, reason?: string }}
 */
function describeAction(verb) {
  if (process.versions.electron === undefined) {
    return {
      supported: false,
      reason: `当前 DSH 以命令行方式运行（dsh web），Pocket 无法${verb}整个进程；请在终端里操作。`,
    };
  }
  if (typeof process.execPath !== 'string' || process.execPath.length === 0 || !existsSync(process.execPath)) {
    return { supported: false, reason: `找不到 DSH 可执行文件，无法${verb}。` };
  }
  const mainPid = process.ppid;
  if (!Number.isInteger(mainPid) || mainPid <= 1) {
    return { supported: false, reason: `无法定位 DSH 主进程，无法${verb}。` };
  }
  return { supported: true };
}

/**
 * 当前运行方式是否支持从 Pocket 重启。
 * @returns {{ supported: boolean, reason?: string }}
 */
export function describeRestart() {
  return describeAction('重启');
}

/**
 * 当前运行方式是否支持从 Pocket 关闭。
 * @returns {{ supported: boolean, reason?: string }}
 */
export function describeShutdown() {
  return describeAction('关闭');
}

/**
 * 调度一次整应用操作。
 *
 * 返回后调用方应立刻把 HTTP 响应发完；辅助进程会等约 1.5 秒再结束主进程，
 * 重启模式下随后重新拉起同一个可执行文件，关闭模式下就此退出。
 *
 * @param {'restart' | 'shutdown'} mode
 * @returns {{ supported: true, action: 'restart' | 'shutdown', pid: number | undefined, pending: boolean }}
 * @throws {Error} 当前运行方式不支持时抛出带 `code = 'restart-unsupported'` 或
 *   `'shutdown-unsupported'` 的错误。
 */
function requestAction(mode) {
  const capability = mode === 'shutdown' ? describeShutdown() : describeRestart();
  if (!capability.supported) {
    const error = new Error(capability.reason ?? '当前运行方式不支持该操作');
    error.code = mode === 'shutdown' ? 'shutdown-unsupported' : 'restart-unsupported';
    throw error;
  }
  if (scheduled) return { supported: true, action: mode, pid: undefined, pending: true };
  scheduled = true;

  const executable = process.execPath;
  const logPath = join(dshHome(), 'pocket', mode === 'shutdown' ? 'shutdown.log' : 'restart.log');
  let child;
  try {
    child = spawn(process.execPath, [
      HELPER_PATH,
      executable,
      String(process.ppid),
      String(process.pid),
      dirname(executable),
      '[]',
      mode,
      String(ACTION_DELAY_MS),
    ], {
      cwd: dirname(executable),
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        DSH_POCKET_RESTART_LOG: logPath,
      },
    });
  } catch (error) {
    scheduled = false;
    throw error;
  }
  if (child.pid === undefined) {
    scheduled = false;
    const error = new Error(mode === 'shutdown' ? '关闭辅助进程启动失败' : '重启辅助进程启动失败');
    error.code = 'restart-helper-failed';
    throw error;
  }
  child.unref();
  child.on('error', () => {
    scheduled = false;
  });
  return { supported: true, action: mode, pid: child.pid, pending: false };
}

/**
 * 调度一次整应用重启。
 * @returns {{ supported: true, action: 'restart', pid: number | undefined, pending: boolean }}
 */
export function requestRestart() {
  return requestAction('restart');
}

/**
 * 调度一次整应用关闭（不再重新拉起）。
 * @returns {{ supported: true, action: 'shutdown', pid: number | undefined, pending: boolean }}
 */
export function requestShutdown() {
  return requestAction('shutdown');
}

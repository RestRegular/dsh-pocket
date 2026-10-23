/**
 * dsh-pocket — DSH 重启 / 关闭辅助进程（在 Electron 的 Node 模式下运行）。
 *
 * 由 `lib/restart.js` 以 `detached` 方式拉起：先等提示信息显示完、HTTP 响应
 * 发完，再结束 Electron 主进程；旧 Host 会在 IPC 断开后自行优雅关闭。重启
 * 模式会等旧 Host 退出后重新启动同一个可执行文件，关闭模式则就此退出，让
 * 整个桌面应用保持关闭。
 *
 * 参数：
 *   1. exe       桌面应用可执行文件（process.execPath）
 *   2. mainPid   Electron 主进程 pid（Host 的父进程）
 *   3. hostPid   当前 Host 进程 pid（重启/关闭前要等它退出）
 *   4. appDir    应用目录，作为新进程的 cwd
 *   5. argsJson  可选的启动参数 JSON 数组（正常为空）
 *   6. mode      `restart`（默认）或 `shutdown`
 *   7. delayMs   动手前的等待时间；让界面提示先显示完（默认 1500ms）
 *
 * 环境变量：
 *   DSH_POCKET_RESTART_LOG  可选，追加一行运行日志的路径。
 *
 * @module dsh-pocket/restart-helper
 */

'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');

/** 等提示显示 / HTTP 响应先落地的默认宽限时间（手机经隧道时留足往返时间）。 */
const RESPONSE_GRACE_MS = 1_500;
/** 等旧 Host 自己收尾的上限。 */
const HOST_EXIT_TIMEOUT_MS = 15_000;
/** 进程退出后，等系统释放单实例锁与文件句柄。 */
const RELAUNCH_DELAY_MS = 1_200;

const sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

/**
 * 进程是否还活着；没有权限查询的进程按“活着”处理。
 * @param {number} pid
 * @returns {boolean}
 */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error !== null && typeof error === 'object' && error.code === 'EPERM';
  }
}

/**
 * 轮询等待进程退出。
 * @param {number} pid
 * @param {number} timeout
 * @returns {Promise<boolean>}
 */
async function waitGone(pid, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await sleep(120);
  }
  return !alive(pid);
}

/**
 * 结束一个进程，失败不抛。
 * @param {number} pid
 * @param {(message: string) => void} log
 */
function terminate(pid, log) {
  if (!alive(pid)) return;
  try {
    process.kill(pid);
    log(`terminated pid=${String(pid)}`);
  } catch (error) {
    log(`terminate pid=${String(pid)} failed: ${String(error && error.message ? error.message : error)}`);
  }
}

/**
 * 解析启动参数。
 * @param {string | undefined} raw
 * @returns {string[]}
 */
function parseArgs(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * 解析可选的等待时间，限制在 0–10 秒，避免异常参数把进程挂住。
 * @param {string | undefined} raw
 * @returns {number}
 */
function parseDelay(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return RESPONSE_GRACE_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return RESPONSE_GRACE_MS;
  return Math.min(value, 10_000);
}

async function main() {
  const [exe, mainPidRaw, hostPidRaw, appDir, argsRaw, modeRaw, delayRaw] = process.argv.slice(2);
  const mode = modeRaw === 'shutdown' ? 'shutdown' : 'restart';
  const delayMs = parseDelay(delayRaw);
  const mainPid = Number(mainPidRaw);
  const hostPid = Number(hostPidRaw);
  const logPath = process.env.DSH_POCKET_RESTART_LOG;
  /** @param {string} message */
  const log = (message) => {
    if (typeof logPath !== 'string' || logPath.length === 0) return;
    try {
      fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
    } catch {
      /* 日志失败不影响操作 */
    }
  };

  if (typeof exe !== 'string' || exe.length === 0) {
    log('missing executable');
    process.exit(2);
  }

  log(`scheduled mode=${mode} exe=${exe} main=${String(mainPid)} host=${String(hostPid)} delay=${String(delayMs)}`);
  // 等提示信息显示完、HTTP 响应发完，再动主进程。
  await sleep(delayMs);

  // 结束主进程后，Host 的 IPC 会断开并自行关闭；主进程是唯一需要强杀的。
  terminate(mainPid, log);
  if (!(await waitGone(mainPid, 5_000))) {
    log('main still alive; retrying');
    terminate(mainPid, log);
    if (!(await waitGone(mainPid, 3_000))) {
      log('main did not exit; aborting');
      process.exit(1);
    }
  }
  if (!(await waitGone(hostPid, HOST_EXIT_TIMEOUT_MS))) {
    log('host did not exit in time; terminating it');
    terminate(hostPid, log);
    await waitGone(hostPid, 3_000);
  }

  if (mode === 'shutdown') {
    log('shutdown complete; not relaunching');
    process.exit(0);
  }

  await sleep(RELAUNCH_DELAY_MS);

  const env = { ...process.env };
  // 这几个变量会让新进程继续以 Node 模式运行，必须清掉。
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  delete env.ELECTRON_ENABLE_LOGGING;
  delete env.DSH_DESKTOP_NODE_EXECUTABLE;
  delete env.DSH_POCKET_RESTART_LOG;

  const child = spawn(exe, parseArgs(argsRaw), {
    cwd: typeof appDir === 'string' && appDir.length > 0 ? appDir : undefined,
    env,
    detached: true,
    windowsHide: false,
    stdio: 'ignore',
  });
  child.on('error', (error) => {
    log(`spawn failed: ${String(error && error.message ? error.message : error)}`);
    process.exit(1);
  });
  child.unref();
  log(`launched pid=${String(child.pid)}`);

  // 给 spawn 一点时间拿到 pid/错误，然后让辅助进程自己退出。
  await sleep(400);
  process.exit(0);
}

main().catch((error) => {
  try {
    console.error(error);
  } catch {
    /* ignore */
  }
  process.exit(1);
});

/**
 * dsh-pocket — 持久化的小状态。
 *
 * 只保存“重启后还要认”的东西：访问令牌、创建时间、面板选中的局域网 IP、
 * 公网入口、“保持电脑常亮”开关、手机端界面（轻量/桌面直通）和手机端截断设置。
 * 端口、隧道地址都是每次启动重新协商的临时状态，不写盘。
 *
 * 存放在 `$DSH_HOME/pocket/state.json`（默认 `~/.dsh/pocket/state.json`），
 * 与 profile 无关——同一台机器上的所有 DSH profile 共用一套 Pocket 令牌，
 * 这样手机书签在切换 profile 后仍然有效。
 *
 * @module dsh-pocket/state
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** `$DSH_HOME` 或 `~/.dsh`。 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : join(homedir(), '.dsh');
}

/** 本插件的状态目录。 */
export function stateDir() {
  return join(dshHome(), 'pocket');
}

/** 状态文件路径。 */
export function statePath() {
  return join(stateDir(), 'state.json');
}

/**
 * 生成一个新的访问令牌：24 字节随机数的 base64url，128 位熵。
 * @returns {string} 32 个字符的 URL 安全令牌。
 */
export function newToken() {
  return randomBytes(24).toString('base64url');
}

/**
 * 读取持久状态；文件不存在或损坏时返回空对象，不抛错。
 * @returns {Promise<{ token?: string, createdAt?: number, tunnel?: string, sshHost?: string, lanAddress?: string, keepAwake?: boolean, display?: object, surface?: 'mobile' | 'desktop' }>}
 */
export async function loadState() {
  try {
    const text = await readFile(statePath(), 'utf8');
    const parsed = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const state = {
        token: typeof parsed.token === 'string' && parsed.token.length >= 16 ? parsed.token : undefined,
        createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : undefined,
      };
      if (parsed.tunnel === 'cloudflared' || parsed.tunnel === 'ssh' || parsed.tunnel === 'auto') {
        state.tunnel = parsed.tunnel;
      }
      if (parsed.surface === 'desktop' || parsed.surface === 'mobile') {
        state.surface = parsed.surface;
      }
      if (typeof parsed.sshHost === 'string' && parsed.sshHost.trim().length > 0) {
        state.sshHost = parsed.sshHost.trim();
      }
      if (typeof parsed.lanAddress === 'string' && parsed.lanAddress.length > 0) {
        state.lanAddress = parsed.lanAddress;
      }
      if (typeof parsed.keepAwake === 'boolean') state.keepAwake = parsed.keepAwake;
      if (parsed.display !== null && typeof parsed.display === 'object' && !Array.isArray(parsed.display)) {
        state.display = parsed.display;
      }
      return state;
    }
  } catch {
    /* 不存在、无权限或 JSON 损坏都按首次运行处理 */
  }
  return {};
}

/**
 * 原子写入持久状态（先写临时文件再改名）。
 * @param {{ token?: string, createdAt?: number, tunnel?: string, sshHost?: string, lanAddress?: string, keepAwake?: boolean, display?: object, surface?: 'mobile' | 'desktop' }} state
 * @returns {Promise<void>}
 */
export async function saveState(state) {
  const dir = stateDir();
  await mkdir(dir, { recursive: true });
  const target = statePath();
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  const body = `${JSON.stringify(state, null, 2)}\n`;
  await writeFile(temp, body, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, target);
}

/**
 * 确保存在一个令牌：优先显式配置，其次落盘状态，最后生成并保存。
 * @param {string | undefined} configured - 来自插件配置的令牌；空字符串视为未配置。
 * @returns {Promise<string>}
 */
export async function ensureToken(configured) {
  if (typeof configured === 'string' && configured.trim().length >= 16) {
    return configured.trim();
  }
  const state = await loadState();
  if (state.token !== undefined) return state.token;
  const token = newToken();
  await saveState({ ...state, token, createdAt: state.createdAt ?? Date.now() });
  return token;
}

/**
 * 记住用户在面板里选择的公网入口与服务器地址。
 * @param {string} tunnel
 * @param {string | undefined} sshHost
 * @returns {Promise<void>}
 */
export async function saveTunnelPreference(tunnel, sshHost) {
  const state = await loadState();
  await saveState({
    ...state,
    tunnel,
    ...(typeof sshHost === 'string' && sshHost.trim().length > 0 ? { sshHost: sshHost.trim() } : {}),
  });
}

/**
 * 轮换令牌并落盘。
 * @returns {Promise<string>}
 */
export async function rotateToken() {
  const state = await loadState();
  const token = newToken();
  await saveState({ ...state, token, createdAt: state.createdAt ?? Date.now() });
  return token;
}

/**
 * 记住「保持电脑常亮」开关，DSH 重启后恢复。
 * @param {boolean} enabled
 * @returns {Promise<void>}
 */
export async function saveKeepAwake(enabled) {
  const state = await loadState();
  await saveState({ ...state, keepAwake: enabled === true });
}

/**
 * 保存手机端界面模式：`mobile` 用 Pocket 自己的轻量页，`desktop` 直接反代桌面
 * Web GUI。切换后手机端刷新即生效。
 * @param {'mobile' | 'desktop'} surface
 * @returns {Promise<void>}
 */
export async function saveSurface(surface) {
  const state = await loadState();
  await saveState({ ...state, surface: surface === 'desktop' ? 'desktop' : 'mobile' });
}

/**
 * 保存手机端的显示/截断设置（桌面面板与手机共用同一份）。
 * @param {{ truncateTools: boolean, truncateAssistant: boolean, truncateReasoning: boolean, limit: number }} display
 * @returns {Promise<void>}
 */
export async function saveDisplaySettings(display) {
  const state = await loadState();
  await saveState({ ...state, display });
}

/**
 * dsh-pocket — 手机端页面。
 *
 * 纯浏览器 ES 模块，无构建、无外部依赖。数据来自同源 `/api/*`：
 *   - 会话列表：GET /api/sessions
 *   - 会话快照 + 实时事件：GET /api/sessions/:id/follow（SSE）
 *   - 发送 / 停止：POST /api/sessions/:id/prompt | cancel
 *
 * 令牌来自 URL 的 `?token=`，写入 localStorage 后立刻从地址栏抹掉；
 * SSE 无法带自定义头，因此以 query 参数携带。
 */

const TOKEN_KEY = 'dsh_pocket_token';
const app = document.getElementById('app');

/* -------------------------------------------------------------------------- */
/* 令牌与 API                                                                  */
/* -------------------------------------------------------------------------- */

function takeTokenFromUrl() {
  const url = new URL(window.location.href);
  const fromQuery = url.searchParams.get('token');
  if (fromQuery !== null && fromQuery.length > 0) {
    localStorage.setItem(TOKEN_KEY, fromQuery);
    url.searchParams.delete('token');
    const clean = `${url.pathname}${url.hash}`;
    window.history.replaceState(null, '', clean);
    return fromQuery;
  }
  return localStorage.getItem(TOKEN_KEY) ?? '';
}

let token = takeTokenFromUrl();

async function api(path, options = {}) {
  const headers = {
    Accept: 'application/json',
    ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    ...(token.length > 0 ? { 'X-Pocket-Token': token } : {}),
    ...(options.headers ?? {}),
  };
  const response = await fetch(path, { ...options, headers });
  if (response.status === 401) {
    showUnlock();
    throw new Error('访问令牌无效或已轮换');
  }
  const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.error ?? `HTTP ${response.status}`);
    // Host 会在会话动作失败时带上稳定 code（例如 workspace/session-active）。
    if (typeof payload.code === 'string') error.code = payload.code;
    if (Array.isArray(payload.activity)) error.activity = payload.activity;
    throw error;
  }
  return payload;
}

/* -------------------------------------------------------------------------- */
/* 通用工具                                                                    */
/* -------------------------------------------------------------------------- */

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function basename(path) {
  if (typeof path !== 'string' || path.length === 0) return '';
  const parts = path.split(/[\\/]/u).filter(Boolean);
  return parts.at(-1) ?? path;
}

/**
 * 文件大小的短标签，移动端只保留一位小数。
 * @param {number} size
 * @returns {string}
 */
function formatBytes(size) {
  const value = typeof size === 'number' && Number.isFinite(size) && size >= 0 ? size : 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function relativeTime(timestamp) {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return '';
  const delta = Date.now() - timestamp;
  if (delta < 60_000) return '刚刚';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  if (delta < 172_800_000) return '昨天';
  if (delta < 604_800_000) return `${Math.floor(delta / 86_400_000)} 天前`;
  const date = new Date(timestamp);
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

function clockTime(timestamp) {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return '';
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function dayLabel(timestamp) {
  if (typeof timestamp !== 'number') return '更早';
  const now = new Date();
  const date = new Date(timestamp);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (timestamp >= start) return '今天';
  if (timestamp >= start - 86_400_000) return '昨天';
  if (timestamp >= start - 7 * 86_400_000) return '本周';
  return '更早';
}

function truncate(text, limit) {
  const value = String(text ?? '');
  return value.length <= limit ? value : `${value.slice(0, limit)}\n…（已截断 ${value.length - limit} 字符）`;
}

/** 截断长度允许范围（字符），与服务端保持一致。 */
const DISPLAY_LIMIT_MIN = 500;
const DISPLAY_LIMIT_MAX = 50_000;

/**
 * 归一化 Host 返回的显示/截断设置；旧 Host 没有该字段时保留当前值。
 * @param {any} raw
 * @returns {{ truncateTools: boolean, truncateAssistant: boolean, truncateReasoning: boolean, limit: number } | undefined}
 */
function normalizeDisplaySettings(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const current = state?.display ?? { truncateTools: true, truncateAssistant: true, truncateReasoning: true, limit: 6_000 };
  const number = Number(raw.limit);
  return {
    truncateTools: typeof raw.truncateTools === 'boolean' ? raw.truncateTools : current.truncateTools,
    truncateAssistant: typeof raw.truncateAssistant === 'boolean' ? raw.truncateAssistant : current.truncateAssistant,
    truncateReasoning: typeof raw.truncateReasoning === 'boolean' ? raw.truncateReasoning : current.truncateReasoning,
    limit: Number.isFinite(number)
      ? Math.min(DISPLAY_LIMIT_MAX, Math.max(DISPLAY_LIMIT_MIN, Math.round(number)))
      : current.limit,
  };
}

/**
 * 按类别截断文本：tool / reasoning / assistant。
 * @param {string} text
 * @param {'tool' | 'reasoning' | 'assistant'} kind
 * @returns {string}
 */
function truncateForDisplay(text, kind) {
  const display = state.display;
  const enabled = kind === 'tool'
    ? display.truncateTools
    : kind === 'reasoning'
      ? display.truncateReasoning
      : display.truncateAssistant;
  return enabled ? truncate(text, display.limit) : String(text ?? '');
}

function prettyJson(text) {
  const value = String(text ?? '');
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function blocksText(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((block) => block?.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');
}

function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
}

let toastTimer;
function toast(message, kind = 'error') {
  document.querySelector('.toast')?.remove();
  const node = el('div', `toast${kind === 'ok' ? ' ok' : ''}`);
  node.textContent = message;
  document.body.appendChild(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), 3600);
}

/* -------------------------------------------------------------------------- */
/* 图标                                                                        */
/* -------------------------------------------------------------------------- */

const ICONS = {
  logo: '<svg viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="pocket-logo-bg" x1="8" y1="4" x2="56" y2="60" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#4f8cff"/><stop offset="1" stop-color="#2b57d8"/></linearGradient></defs><rect x="3" y="3" width="58" height="58" rx="15" fill="url(#pocket-logo-bg)"/><rect x="19" y="12" width="26" height="40" rx="7" fill="none" stroke="#ffffff" stroke-width="3.2"/><path d="M26 17.5h12" stroke="#ffffff" stroke-width="2.6" stroke-linecap="round" opacity=".85"/><circle cx="32" cy="45.5" r="2.1" fill="#ffffff" opacity=".9"/><path d="M43 18c5.4 2.7 8.7 7.7 8.7 14s-3.3 11.3-8.7 14" fill="none" stroke="#bfe0ff" stroke-width="2.4" stroke-linecap="round"/><path d="M46.4 23.2c3 2 4.8 5.3 4.8 8.8s-1.8 6.8-4.8 8.8" fill="none" stroke="#8cc4ff" stroke-width="2.2" stroke-linecap="round" opacity=".9"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.34 5.66"/><path d="M20 5v6h-6"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m14.5 5-7 7 7 7"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m6 11 6-6 6 6"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5a3.5 3.5 0 0 1-3.5 3.5H9l-4 3v-3.6A3.5 3.5 0 0 1 4 14.5v-6A3.5 3.5 0 0 1 7.5 5h9A3.5 3.5 0 0 1 20 8.5Z"/></svg>',
  tool: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 6.5a4 4 0 0 0 5 5L10 21l-3-3 9.5-9.5Z"/><path d="M6 6h.01"/></svg>',
  terminal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="m7 9 3.2 3L7 15"/><path d="M12.5 15H17"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5h8l4 4V20a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5 20V5A1.5 1.5 0 0 1 6.5 3.5Z"/><path d="M14 3.5V8h4.5"/></svg>',
  web: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.4 2.3 3.7 5.3 3.7 8.5S14.4 18.2 12 20.5C9.6 18.2 8.3 15.2 8.3 12S9.6 5.8 12 3.5Z"/></svg>',
  agent: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="7" width="16" height="12" rx="3"/><path d="M12 3.5V7"/><circle cx="9" cy="13" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="13" r="1" fill="currentColor" stroke="none"/><path d="M9.5 16.5h5"/></svg>',
  spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3Z"/><path d="m18.5 15 .8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h4l2 2.5h6A2.5 2.5 0 0 1 20.5 10v7A2.5 2.5 0 0 1 18 19.5H6A2.5 2.5 0 0 1 3.5 17Z"/></svg>',
  archive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="5" rx="1.5"/><path d="M5 9.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19V9.5"/><path d="M10 13.5h4"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4.5h6l-.8 5.2 3.3 3.3H6.5l3.3-3.3L9 4.5Z"/><path d="M12 13v7"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 5 7 7-7 7"/></svg>',
  chevronDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 9 7 7 7-7"/></svg>',
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="m5 17 4.5-4.5 3.5 3.5 2.5-2.5L19 17"/></svg>',
  sliders: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="7" cy="17" r="2"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1.1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1Z"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2.5 5 13.5h6.2L11 21.5l8-11h-6.2z"/></svg>',
  wallet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8.5A2.5 2.5 0 0 1 6.5 6H18a1 1 0 0 1 1 1v2"/><rect x="3.5" y="8" width="17" height="11.5" rx="3"/><path d="M20.5 12H16a2 2 0 0 0 0 4h4.5"/></svg>',
  question: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M9.5 9.2a2.6 2.6 0 0 1 5 .9c0 1.7-2.5 2.1-2.5 3.7"/><path d="M12 17.2h.01"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5.5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="18.5" cy="12" r="1.9"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M15 5.5A1.5 1.5 0 0 0 13.5 4H6a2 2 0 0 0-2 2v7.5A1.5 1.5 0 0 0 5.5 15"/></svg>',
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 15.2A8.5 8.5 0 0 1 8.8 4a8.5 8.5 0 1 0 11.2 11.2Z"/></svg>',
  autoTheme: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17Z" fill="currentColor" stroke="none"/></svg>',
  dot: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="4"/></svg>',
};

const THEME_KEY = 'dsh_pocket_theme';
const THEME_MODES = ['system', 'light', 'dark'];

function loadThemeMode() {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return THEME_MODES.includes(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

let themeMode = loadThemeMode();

function resolvedTheme() {
  if (themeMode === 'light' || themeMode === 'dark') return themeMode;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function themeIcon() {
  return themeMode === 'light' ? ICONS.sun : themeMode === 'dark' ? ICONS.moon : ICONS.autoTheme;
}

function themeLabel() {
  return themeMode === 'light' ? '浅色主题' : themeMode === 'dark' ? '深色主题' : '跟随系统主题';
}

function applyTheme() {
  const theme = resolvedTheme();
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta !== null) meta.setAttribute('content', theme === 'light' ? '#f5f7fb' : '#0b0e14');
  const statusBar = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
  if (statusBar !== null) statusBar.setAttribute('content', theme === 'light' ? 'default' : 'black-translucent');
  for (const button of document.querySelectorAll('.theme-toggle')) {
    button.innerHTML = themeIcon();
    button.title = `主题：${themeLabel()}（点击切换）`;
    button.setAttribute('aria-label', `主题：${themeLabel()}`);
  }
}

function cycleTheme() {
  const next = THEME_MODES[(THEME_MODES.indexOf(themeMode) + 1) % THEME_MODES.length];
  setThemeMode(next);
}

/**
 * 直接设置主题模式（设置页与顶栏共用）。
 * @param {'system' | 'light' | 'dark'} next
 */
function setThemeMode(next) {
  if (!THEME_MODES.includes(next)) return;
  themeMode = next;
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* private mode */
  }
  applyTheme();
}

function bindThemeButtons() {
  for (const button of document.querySelectorAll('.theme-toggle')) {
    button.addEventListener('click', cycleTheme);
  }
  applyTheme();
}

try {
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    if (themeMode === 'system') applyTheme();
  });
} catch {
  /* old Safari */
}

applyTheme();

/**
 * 按工具名挑一个更贴题的图标。
 * @param {string | undefined} name
 * @returns {string}
 */
function toolIcon(name) {
  const value = String(name ?? '').toLowerCase();
  if (/(bash|pwsh|shell|terminal|job|exec)/u.test(value)) return ICONS.terminal;
  if (/(read|write|edit|glob|grep|fs|present|deliver)/u.test(value)) return ICONS.file;
  if (/(web|fetch|search|browse)/u.test(value)) return ICONS.web;
  if (/(subagent|agent|team|spawn)/u.test(value)) return ICONS.agent;
  if (/(skill|memory|goal|plan|todo)/u.test(value)) return ICONS.spark;
  return ICONS.tool;
}

/* -------------------------------------------------------------------------- */
/* Markdown（先转义，再做最小语法）                                             */
/* -------------------------------------------------------------------------- */

/**
 * 把 Markdown 图片地址解析成手机端可加载的 URL。
 * 相对路径通过会话工作区文件接口读取。
 * @param {string} source
 * @returns {string}
 */
function markdownImageUrl(source) {
  const value = String(source ?? '').trim();
  if (/^(?:https?:|data:image\/|blob:|\/)/iu.test(value)) return value;
  const sessionId = state.current?.id;
  if (sessionId === undefined || value.length === 0) return value;
  return `/api/sessions/${encodeURIComponent(sessionId)}/file`
    + `?path=${encodeURIComponent(value)}&token=${encodeURIComponent(token)}`;
}

/**
 * 渲染一个 Markdown 图片节点；外面包一层链接，方便点开大图。
 * @param {{ alt: string, src: string }} image
 * @returns {string}
 */
function markdownImageHtml(image) {
  const url = escapeHtml(markdownImageUrl(image.src));
  const alt = escapeHtml(image.alt);
  return `<a class="md-image" href="${url}" target="_blank" rel="noopener noreferrer">`
    + `<img src="${url}" alt="${alt}" loading="lazy"></a>`;
}

/**
 * 切分 Markdown 表格行。
 * @param {string} line
 * @returns {string[]}
 */
function tableCells(line) {
  return line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split('|').map((cell) => cell.trim());
}

/**
 * 是否是表格的 `| --- | :---: |` 分隔行。
 * @param {string} line
 * @returns {boolean}
 */
function isTableSeparator(line) {
  const cells = tableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/u.test(cell));
}

/**
 * 表格单元格对齐方式。
 * @param {string} cell
 * @returns {'left' | 'center' | 'right' | ''}
 */
function tableAlign(cell) {
  const value = cell.trim();
  const left = value.startsWith(':');
  const right = value.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return '';
}

/**
 * 渲染表格。
 * @param {string[]} header
 * @param {string[]} aligns
 * @param {string[][]} rows
 * @returns {string}
 */
function tableHtml(header, aligns, rows) {
  const style = (index) => (aligns[index] === undefined || aligns[index] === '' ? '' : ` style="text-align:${aligns[index]}"`);
  const head = header.map((cell, index) => `<th${style(index)}>${cell}</th>`).join('');
  const body = rows.map((row) => `<tr>${header.map((_, index) => `<td${style(index)}>${row[index] ?? ''}</td>`).join('')}</tr>`).join('');
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderMarkdown(source) {
  const text = String(source ?? '');
  if (text.trim().length === 0) return '';
  const codeBlocks = [];
  let working = text.replace(/```([^\n`]*)\n([\s\S]*?)```/gu, (_match, lang, code) => {
    codeBlocks.push({ lang: String(lang).trim(), code });
    return `\u0000${codeBlocks.length - 1}\u0000`;
  });

  // 图片必须在 escapeHtml 之前抽出来，避免 ![alt](src) 被链接正则拆坏。
  const images = [];
  working = working.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu, (_match, alt, src) => {
    images.push({ alt, src });
    return `\u0001${images.length - 1}\u0001`;
  });

  working = escapeHtml(working);
  working = working.replace(/\u0001(\d+)\u0001/gu, (_match, index) => {
    const image = images[Number(index)];
    return image === undefined ? '' : markdownImageHtml(image);
  });
  working = working.replace(/`([^`\n]+)`/gu, '<code>$1</code>');
  working = working.replace(/\*\*([^*\n]+)\*\*/gu, '<strong>$1</strong>');
  working = working.replace(/(^|[^*])\*([^*\n]+)\*/gu, '$1<em>$2</em>');
  working = working.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gu, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  working = working.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/gu, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');

  const lines = working.split('\n');
  const out = [];
  let paragraph = [];
  let list = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      out.push(`<p>${paragraph.join('<br>')}</p>`);
      paragraph = [];
    }
  };
  const closeList = () => {
    if (list !== null) {
      out.push(`</${list}>`);
      list = null;
    }
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const codeMatch = /^\u0000(\d+)\u0000$/u.exec(line.trim());
    if (codeMatch !== null) {
      flushParagraph();
      closeList();
      const block = codeBlocks[Number(codeMatch[1])];
      if (block !== undefined) {
        const lang = block.lang.length > 0 ? ` data-lang="${escapeHtml(block.lang)}"` : '';
        out.push(`<pre${lang}><code>${escapeHtml(block.code.replace(/\n$/u, ''))}</code></pre>`);
      }
      continue;
    }
    if (line.trim().length === 0) {
      flushParagraph();
      closeList();
      continue;
    }
    if (line.includes('|') && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      flushParagraph();
      closeList();
      const header = tableCells(line);
      const aligns = tableCells(lines[index + 1]).map(tableAlign);
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].trim().length > 0 && lines[index].includes('|')) {
        rows.push(tableCells(lines[index]));
        index += 1;
      }
      index -= 1;
      out.push(tableHtml(header, aligns, rows));
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/u.exec(line);
    if (heading !== null) {
      flushParagraph();
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${heading[2]}</h${level}>`);
      continue;
    }
    if (/^(-{3,}|\*{3,})$/u.test(line.trim())) {
      flushParagraph();
      closeList();
      out.push('<hr>');
      continue;
    }
    const unordered = /^\s*[-*+]\s+(.*)$/u.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.*)$/u.exec(line);
    if (unordered !== null || ordered !== null) {
      flushParagraph();
      const wanted = unordered !== null ? 'ul' : 'ol';
      if (list !== wanted) {
        closeList();
        out.push(`<${wanted}>`);
        list = wanted;
      }
      out.push(`<li>${(unordered ?? ordered)[1]}</li>`);
      continue;
    }
    const quote = /^>\s?(.*)$/u.exec(line);
    if (quote !== null) {
      flushParagraph();
      closeList();
      out.push(`<blockquote>${quote[1]}</blockquote>`);
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  closeList();
  return out.join('');
}

/* -------------------------------------------------------------------------- */
/* 状态                                                                        */
/* -------------------------------------------------------------------------- */

const state = {
  view: 'list',
  sessions: [],
  workspaces: [],
  unassigned: [],
  archived: [],
  counts: { total: 0, workspaces: 0, archived: 0 },
  features: undefined,
  awake: undefined,
  display: { truncateTools: true, truncateAssistant: true, truncateReasoning: true, limit: 6_000 },
  pinnedIds: [],
  showArchived: localStorage.getItem('dsh_pocket_show_archived') === '1',
  collapsed: (() => {
    try {
      const stored = JSON.parse(localStorage.getItem('dsh_pocket_collapsed_ws') ?? '[]');
      return new Set(Array.isArray(stored) ? stored : []);
    } catch {
      return new Set();
    }
  })(),
  filter: '',
  connected: true,
  listTimer: undefined,
  current: undefined,
  pendingTexts: [],
  balance: undefined,
  alerts: new Map(),
  dismissedAlerts: new Set(),
};

function stopListTimer() {
  if (state.listTimer !== undefined) {
    clearInterval(state.listTimer);
    state.listTimer = undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* 解锁                                                                        */
/* -------------------------------------------------------------------------- */

function showUnlock(message) {
  stopListTimer();
  closeChat();
  closeFilePreview();
  closeFileBrowser();
  disconnectEvents();
  state.alerts.clear();
  state.view = 'unlock';
  renderAlerts();
  app.innerHTML = '';
  const wrap = el('div', 'unlock');
  const card = el('div', 'modal');
  card.innerHTML = `
    <h3>连接 Pocket</h3>
    <p>${escapeHtml(message ?? '请输入桌面端「Pocket 随身访问」面板里显示的访问令牌。')}</p>
    <input id="unlock-token" type="password" autocomplete="off" placeholder="访问令牌" value="${escapeHtml(token)}">
    <div class="modal-actions">
      <button class="btn primary" id="unlock-btn">解锁</button>
    </div>`;
  wrap.appendChild(card);
  app.appendChild(wrap);
  const input = card.querySelector('#unlock-token');
  const submit = () => {
    const value = input.value.trim();
    if (value.length === 0) return;
    token = value;
    localStorage.setItem(TOKEN_KEY, token);
    loadSessions();
  };
  card.querySelector('#unlock-btn').addEventListener('click', submit);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submit();
  });
  requestAnimationFrame(() => input.focus());
}

/* -------------------------------------------------------------------------- */
/* 会话列表                                                                    */
/* -------------------------------------------------------------------------- */

function openSession(id) {
  window.location.hash = `#/s/${encodeURIComponent(id)}`;
}

function renderShell() {
  app.innerHTML = `
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">${ICONS.logo}</span>
        <div>
          <div class="brand-name">Pocket</div>
          <div class="brand-sub" id="list-sub">正在读取会话…</div>
        </div>
      </div>
      <button class="iconbtn theme-toggle" title="主题"></button>
      <button class="iconbtn${state.showArchived ? ' active' : ''}" id="archived-toggle" title="${state.showArchived ? '隐藏已归档会话' : '显示已归档会话'}" aria-label="已归档">${ICONS.archive}</button>
      <button class="iconbtn" id="awake-toggle" title="电脑常亮" aria-label="保持电脑常亮" aria-pressed="false">${ICONS.bolt}</button>
      <button class="iconbtn" id="refresh" title="刷新">${ICONS.refresh}</button>
    </header>
    <div class="list-scroll" id="list-scroll">
      <button class="balance-card" id="balance-card" hidden title="点击刷新余额"></button>
      <button class="settings-entry" id="settings-entry" style="display:none">${ICONS.gear}<span>设置</span>${ICONS.chevron}</button>
      <div class="search">${ICONS.search}<input id="search" placeholder="搜索会话、工作区或目录" autocomplete="off"></div>
      <div id="session-list"></div>
    </div>`;
  bindThemeButtons();
  document.querySelector('#settings-entry').addEventListener('click', () => openDisplaySettings());
  updateDisplaySettingsEntry();
}

/**
 * 把宿主返回的分组数据写入本地状态。
 * @param {any} payload
 */
function applySessionPayload(payload) {
  state.sessions = Array.isArray(payload.items) ? payload.items : [];
  state.workspaces = Array.isArray(payload.workspaces) ? payload.workspaces : [];
  state.unassigned = Array.isArray(payload.unassigned) ? payload.unassigned : [];
  state.archived = Array.isArray(payload.archived) ? payload.archived : [];
  state.counts = payload.counts ?? { total: state.sessions.length, workspaces: state.workspaces.length, archived: state.archived.length };
  // 旧 Host 不返回 features；保持 undefined，行内“更多”入口就不渲染。
  if (payload.features !== undefined) state.features = payload.features;
  if (payload.awake !== undefined) state.awake = payload.awake;
  const display = normalizeDisplaySettings(payload.display);
  if (display !== undefined) state.display = display;
  updateDisplaySettingsEntry();
  // 置顶集合按“最近置顶在前”返回，组内置顶行按这个顺序排。
  const pinnedRows = Array.isArray(payload.pinned) ? payload.pinned : [];
  state.pinnedIds = pinnedRows.map((row) => row.id);
  // 会话列表顺带带回待处理提问/审批；事件流断开时靠轮询也能更新顶部提示。
  if (Array.isArray(payload.pending)) replaceAlerts(payload.pending);
}

async function loadSessions(options = {}) {
  state.view = 'list';
  if (window.location.hash !== '' && window.location.hash !== '#/') {
    window.history.replaceState(null, '', '#/');
  }
  closeChat();
  if (options.skeleton !== false) {
    app.innerHTML = '<div class="boot"><div class="boot-logo"></div><div class="boot-text">正在读取会话…</div></div>';
  }
  try {
    const payload = await api('/api/sessions');
    applySessionPayload(payload);
    state.connected = true;
    renderShell();
    bindListEvents();
    renderSessionList();
    renderAlerts();
    void ensureBalance(false);
    ensureEvents();
    stopListTimer();
    state.listTimer = setInterval(() => {
      if (state.view === 'list' && document.visibilityState === 'visible') {
        void refreshSessionsQuietly();
      }
    }, 8000);
  } catch (error) {
    if (state.view === 'unlock') return;
    state.connected = false;
    app.innerHTML = `<div class="boot"><div class="boot-logo" style="animation:none;background:#3a1d25"></div><div class="boot-text">${escapeHtml(error.message ?? String(error))}</div><button class="btn" style="width:180px;margin-top:8px" id="retry">重试</button></div>`;
    document.querySelector('#retry')?.addEventListener('click', () => loadSessions());
  }
}

/** 列表工具栏的事件绑定（renderShell 重建后需要重新绑）。 */
function bindListEvents() {
  document.querySelector('#refresh')?.addEventListener('click', () => loadSessions({ skeleton: false }));
  document.querySelector('#archived-toggle')?.addEventListener('click', () => {
    state.showArchived = !state.showArchived;
    localStorage.setItem('dsh_pocket_show_archived', state.showArchived ? '1' : '0');
    renderShell();
    bindListEvents();
    renderSessionList();
  });
  document.querySelector('#balance-card')?.addEventListener('click', () => {
    const card = document.querySelector('#balance-card');
    card?.classList.add('loading');
    void ensureBalance(true).finally(() => {
      document.querySelector('#balance-card')?.classList.remove('loading');
    });
  });
  const search = document.querySelector('#search');
  if (search !== null) {
    search.value = state.filter;
    search.addEventListener('input', () => {
      state.filter = search.value.trim();
      renderSessionList();
    });
  }
  document.querySelector('#awake-toggle')?.addEventListener('click', () => void toggleAwake());
  updateAwakeButton();
  renderBalance();
}

/** 顶栏「电脑常亮」按钮跟随 Host 状态。 */
function updateAwakeButton() {
  const button = document.querySelector('#awake-toggle');
  if (button === null) return;
  const awake = state.awake;
  const unsupported = awake?.supported === false;
  const active = awake?.active === true;
  button.classList.toggle('active', active);
  button.disabled = unsupported;
  button.setAttribute('aria-pressed', active ? 'true' : 'false');
  button.title = unsupported
    ? '当前平台不支持保持常亮'
    : active
      ? '电脑常亮：已开启（点击关闭）'
      : '电脑常亮：已关闭（点击开启）';
}

/** 在手机上开关宿主的「保持电脑常亮」。 */
async function toggleAwake() {
  if (state.awake?.supported === false) {
    toast('当前平台不支持保持常亮');
    return;
  }
  const enabled = state.awake?.active !== true;
  const button = document.querySelector('#awake-toggle');
  if (button !== null) button.disabled = true;
  try {
    const payload = await api('/api/keep-awake', {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    });
    state.awake = payload.awake;
    updateAwakeButton();
    toast(enabled ? '已开启电脑常亮' : '已关闭电脑常亮', 'ok');
  } catch (error) {
    toast(error.message ?? '切换失败');
  } finally {
    const node = document.querySelector('#awake-toggle');
    if (node !== null) node.disabled = state.awake?.supported === false;
  }
}

async function refreshSessionsQuietly() {
  try {
    const payload = await api('/api/sessions');
    applySessionPayload(payload);
    state.connected = true;
    if (state.view === 'list') {
      renderSessionList();
      updateAwakeButton();
    }
  } catch {
    state.connected = false;
  }
}

/* -------------------------------------------------------------------------- */
/* 账户余额                                                                    */
/* -------------------------------------------------------------------------- */

let balanceFetchedAt = 0;

/**
 * 把平台的原始余额字符串格式化成 `¥12.34` / `-$0.50`。
 * 正金额截断到分，小于一分显示 `<0.01`；负金额按四舍五入显示。
 * @param {string | number} balance
 * @param {string | undefined} currency
 * @returns {string}
 */
function formatMoney(balance, currency) {
  const symbol = currency === 'USD' ? '$' : '¥';
  const value = Number(balance);
  if (!Number.isFinite(value)) return `${symbol}${String(balance ?? '')}`;
  const negative = value < 0;
  const abs = Math.abs(value);
  const cents = negative ? Math.round(abs * 100) / 100 : Math.floor(abs * 100) / 100;
  const sign = negative ? '-' : '';
  if (cents === 0 && abs > 0) return `${sign}${symbol}<0.01`;
  return `${sign}${symbol}${cents.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function renderBalance() {
  const card = document.querySelector('#balance-card');
  if (card === null) return;
  if (state.features?.balance !== true) {
    card.hidden = true;
    card.replaceChildren();
    return;
  }
  const payload = state.balance;
  if (payload === undefined) {
    card.hidden = false;
    card.innerHTML = `
      <span class="balance-glyph">${ICONS.wallet}</span>
      <span class="balance-text">
        <span class="balance-label">账户余额</span>
        <span class="balance-value">读取中…</span>
      </span>`;
    return;
  }
  if (payload.available !== true) {
    // 未登录、API Key 模式或查询失败时不打扰用户，直接隐藏卡片。
    card.hidden = true;
    return;
  }
  const wallets = (payload.wallets ?? []).map((wallet) => formatMoney(wallet.balance, wallet.currency));
  const bonuses = (payload.bonusWallets ?? [])
    .filter((wallet) => Number(wallet.balance) > 0)
    .map((wallet) => `赠金 ${formatMoney(wallet.balance, wallet.currency)}`);
  card.hidden = false;
  card.innerHTML = `
    <span class="balance-glyph">${ICONS.wallet}</span>
    <span class="balance-text">
      <span class="balance-label">账户余额</span>
      <span class="balance-value">${escapeHtml(wallets.length > 0 ? wallets.join(' · ') : '暂无可用额度')}</span>
    </span>
    ${bonuses.length > 0 ? `<span class="balance-bonus">${escapeHtml(bonuses.join(' · '))}</span>` : ''}
    <span class="balance-refresh">${ICONS.refresh}</span>`;
}

/**
 * 读取余额：默认使用 60 秒客户端缓存；点击卡片时强制刷新。
 * @param {boolean} force
 * @returns {Promise<void>}
 */
async function ensureBalance(force = false) {
  if (state.features?.balance !== true) {
    renderBalance();
    return;
  }
  if (!force && state.balance !== undefined && Date.now() - balanceFetchedAt < 60_000) {
    renderBalance();
    return;
  }
  renderBalance();
  try {
    const payload = await api(`/api/balance${force ? '?force=1' : ''}`);
    state.balance = payload;
    balanceFetchedAt = Date.now();
  } catch {
    if (state.balance === undefined) state.balance = { available: false, reason: 'failed' };
  }
  renderBalance();
}

/* -------------------------------------------------------------------------- */
/* 全局提醒：别的会话被提问/审批阻塞                                             */
/* -------------------------------------------------------------------------- */

let eventsSocket;
let eventsTimer;
let eventsBackoff = 1000;

function alertText(item) {
  if (item?.interactionKind === 'approval') return `请求批准：${item.toolName ?? '工具'}`;
  const count = Number(item?.count);
  return count > 1 ? `有 ${count} 个问题等待回答` : '有提问等待回答';
}

/**
 * 会话页只显示“其他会话”的提示；当前会话由输入框上方的问答条负责。
 * @returns {object[]}
 */
function visibleAlerts() {
  const currentId = state.current?.id;
  return [...state.alerts.values()]
    .filter((item) => item.sessionId !== currentId)
    .sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0));
}

function renderAlerts() {
  let container = document.getElementById('alerts');
  if (container === null) {
    container = el('div', 'alerts');
    container.id = 'alerts';
    document.body.appendChild(container);
  }
  const items = state.view === 'unlock' ? [] : visibleAlerts();
  if (items.length === 0) {
    container.replaceChildren();
    container.hidden = true;
    return;
  }
  container.hidden = false;
  const shown = items.slice(-3);
  const extra = items.length - shown.length;
  container.innerHTML = shown.map((item) => {
    const title = item.title === undefined ? '其他会话' : `「${item.title}」`;
    const icon = item.interactionKind === 'approval' ? ICONS.tool : ICONS.question;
    return `
      <div class="alert" role="button" tabindex="0" data-alert-session="${escapeHtml(item.sessionId)}">
        <span class="alert-icon">${icon}</span>
        <span class="alert-copy">
          <span class="alert-title">${escapeHtml(title)}</span>
          <span class="alert-text">${escapeHtml(alertText(item))}</span>
        </span>
        <span class="alert-go">查看</span>
        <button class="alert-close" type="button" data-alert-dismiss="${escapeHtml(item.requestId)}" title="忽略这条提示" aria-label="忽略">${ICONS.close}</button>
      </div>`;
  }).join('') + (extra > 0 ? `<div class="alerts-extra">还有 ${extra} 条提醒</div>` : '');

  for (const node of container.querySelectorAll('[data-alert-session]')) {
    const open = () => {
      // 弹层打开时直接切会话会留下遮罩。
      for (const mask of document.querySelectorAll('.modal-mask')) mask.remove();
      openSession(node.dataset.alertSession);
    };
    node.addEventListener('click', (event) => {
      const dismiss = event.target.closest?.('[data-alert-dismiss]');
      if (dismiss !== null && dismiss !== undefined) {
        event.stopPropagation();
        const requestId = dismiss.dataset.alertDismiss;
        if (typeof requestId === 'string') {
          state.dismissedAlerts.add(requestId);
          state.alerts.delete(requestId);
          renderAlerts();
        }
        return;
      }
      open();
    });
    node.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      open();
    });
  }
}

function sameAlerts(next) {
  if (next.size !== state.alerts.size) return false;
  for (const [requestId, item] of next) {
    const previous = state.alerts.get(requestId);
    if (previous === undefined) return false;
    if (previous.title !== item.title
      || previous.interactionKind !== item.interactionKind
      || previous.count !== item.count
      || previous.toolName !== item.toolName) return false;
  }
  return true;
}

function replaceAlerts(pending) {
  const next = new Map();
  for (const item of Array.isArray(pending) ? pending : []) {
    if (item === null || typeof item !== 'object' || typeof item.requestId !== 'string') continue;
    if (state.dismissedAlerts.has(item.requestId)) continue;
    next.set(item.requestId, item);
  }
  // 8 秒一次的列表轮询大部分时候内容不变，避免重复重绘让提示反复闪入。
  if (sameAlerts(next)) return;
  state.alerts = next;
  renderAlerts();
}

function upsertAlert(item) {
  if (item === null || typeof item !== 'object' || typeof item.requestId !== 'string') return;
  if (state.dismissedAlerts.has(item.requestId)) return;
  state.alerts.set(item.requestId, item);
  renderAlerts();
}

function removeAlert(requestId) {
  if (typeof requestId !== 'string' || requestId.length === 0) return;
  state.alerts.delete(requestId);
  state.dismissedAlerts.delete(requestId);
  renderAlerts();
}

function ensureEvents() {
  if (state.features?.notifications !== true) return;
  if (token.length === 0 || state.view === 'unlock') return;
  if (eventsSocket !== undefined) return;
  connectEvents();
}

function connectEvents() {
  if (token.length === 0 || state.features?.notifications !== true) return;
  clearTimeout(eventsTimer);
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  let socket;
  try {
    socket = new WebSocket(`${scheme}://${window.location.host}/ws/events?token=${encodeURIComponent(token)}`);
  } catch {
    scheduleEventsReconnect();
    return;
  }
  eventsSocket = socket;
  socket.onopen = () => {
    eventsBackoff = 1000;
  };
  socket.onmessage = (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.kind === 'interactions') {
      replaceAlerts(message.pending);
    } else if (message.kind === 'interaction-pending' || message.kind === 'interaction-update') {
      upsertAlert(message);
    } else if (message.kind === 'interaction-resolved') {
      removeAlert(message.requestId);
    }
  };
  socket.onerror = () => {
    if (eventsSocket !== socket) return;
    try {
      socket.close();
    } catch {
      /* ignore */
    }
  };
  socket.onclose = () => {
    if (eventsSocket !== socket) return;
    eventsSocket = undefined;
    scheduleEventsReconnect();
  };
}

function scheduleEventsReconnect() {
  clearTimeout(eventsTimer);
  if (token.length === 0 || state.view === 'unlock' || state.features?.notifications !== true) return;
  eventsTimer = setTimeout(() => {
    connectEvents();
  }, eventsBackoff);
  eventsBackoff = Math.min(eventsBackoff * 2, 30_000);
}

function disconnectEvents() {
  clearTimeout(eventsTimer);
  eventsTimer = undefined;
  const socket = eventsSocket;
  eventsSocket = undefined;
  if (socket !== undefined) {
    try {
      socket.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * 会话行在搜索条件下的匹配。
 * @param {any} row
 * @param {string} filter
 * @returns {boolean}
 */
function rowMatches(row, filter) {
  if (filter.length === 0) return true;
  return `${row.title ?? ''} ${row.cwd ?? ''}`.toLowerCase().includes(filter);
}

/**
 * 工作区分组的折叠 key。
 * @param {{ kind: string, id?: string }} group
 * @returns {string}
 */
function workspaceGroupKey(group) {
  return group.kind === 'workspace' ? `ws:${group.id}` : group.kind;
}

/**
 * 渲染一个工作区分组。
 * @param {{ kind: string, id?: string, title: string, path?: string, sessions: any[] }} group
 * @param {boolean} showPathInRows
 * @returns {string}
 */
function renderWorkspaceGroup(group, showPathInRows) {
  const key = workspaceGroupKey(group);
  const collapsed = state.collapsed.has(key);
  const icon = group.kind === 'archived' ? ICONS.archive : ICONS.folder;
  const pinRank = new Map(state.pinnedIds.map((id, index) => [id, index]));
  const sessions = [...group.sessions].sort((left, right) => {
    const leftPinned = pinRank.has(left.id);
    const rightPinned = pinRank.has(right.id);
    if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
    if (leftPinned && rightPinned) return pinRank.get(left.id) - pinRank.get(right.id);
    return (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
  });
  const addButton = group.kind === 'workspace' && typeof group.path === 'string' && group.path.length > 0
    ? `<button class="ws-add" data-ws-path="${escapeHtml(group.path)}" title="在此工作区新建会话" aria-label="在此工作区新建会话">${ICONS.plus}</button>`
    : '';
  const filesButton = group.kind === 'workspace' && typeof group.path === 'string' && group.path.length > 0
    && state.features?.fileTree === true
    ? `<button class="ws-add ws-files" data-ws-files="${escapeHtml(group.path)}" data-ws-title="${escapeHtml(group.title ?? '工作区')}" title="浏览工作区文件" aria-label="浏览工作区文件">${ICONS.folder}</button>`
    : '';
  let html = `
    <div class="ws-head ws-${escapeHtml(group.kind)}">
      <button class="ws-toggle" data-ws-key="${escapeHtml(key)}" aria-expanded="${String(!collapsed)}">
        <span class="ws-chevron">${collapsed ? ICONS.chevron : ICONS.chevronDown}</span>
        <span class="ws-icon">${icon}</span>
        <span class="ws-title">${escapeHtml(group.title)}</span>
        <span class="ws-count">${sessions.length}</span>
      </button>
      ${filesButton}
      ${addButton}
    </div>`;
  if (collapsed) return html;
  if (typeof group.path === 'string' && group.path.length > 0) {
    html += `<div class="ws-path" title="${escapeHtml(group.path)}">${escapeHtml(group.path)}</div>`;
  }
  if (sessions.length === 0) {
    html += '<div class="ws-empty">暂无会话</div>';
    return html;
  }
  let rows = '';
  const actions = state.features?.sessionActions === true;
  for (const item of sessions) {
    const pills = [
      item.running === true ? '<span class="pill run">运行中</span>' : '',
      item.pinned === true ? `<span class="pill pin">${ICONS.pin}置顶</span>` : '',
      group.kind === 'archived' ? '<span class="pill arc">已归档</span>' : '',
    ].filter(Boolean).join('');
    const meta = showPathInRows
      ? `<span class="session-meta"><span class="cwd">${escapeHtml(item.cwd || '未绑定目录')}</span></span>`
      : '';
    const more = actions
      ? `<button class="session-more" data-more-id="${escapeHtml(item.id)}" title="更多操作" aria-label="更多操作" aria-haspopup="menu">${ICONS.more}</button>`
      : '';
    rows += `
      <div class="session-row">
        <button class="session${item.running === true ? ' running' : ''}${item.archived === true ? ' archived' : ''}" data-id="${escapeHtml(item.id)}">
          <span class="session-main">
            <span class="session-title"><span>${escapeHtml(item.title ?? '会话')}</span>${pills}</span>
            ${meta}
          </span>
          <span class="session-time">${escapeHtml(relativeTime(item.updatedAt))}</span>
        </button>
        ${more}
      </div>`;
  }
  html += `<div class="ws-sessions">${rows}</div>`;
  return html;
}

function renderSessionList() {
  const container = document.querySelector('#session-list');
  if (container === null) return;
  const sub = document.querySelector('#list-sub');
  const filter = state.filter.toLowerCase();
  const groups = [];
  for (const workspace of state.workspaces) {
    const workspaceText = `${workspace.title ?? ''} ${workspace.path ?? ''}`.toLowerCase();
    const workspaceMatches = filter.length === 0 || workspaceText.includes(filter);
    const sessions = (workspace.sessions ?? [])
      .filter((row) => row.blank !== true)
      .filter((row) => workspaceMatches || rowMatches(row, filter));
    if (filter.length > 0 && sessions.length === 0) continue;
    groups.push({
      kind: 'workspace',
      id: workspace.id,
      title: workspace.title ?? (workspace.path ?? '工作区'),
      path: workspace.path,
      sessions,
    });
  }

  const unassigned = state.unassigned.filter((row) => row.blank !== true && rowMatches(row, filter));
  if (unassigned.length > 0) {
    groups.push({ kind: 'unassigned', title: '未分组', path: '', sessions: unassigned });
  }

  if (state.showArchived) {
    const archived = state.archived.filter((row) => row.blank !== true && rowMatches(row, filter));
    if (archived.length > 0) {
      groups.push({ kind: 'archived', title: '已归档', path: '', sessions: archived });
    }
  }

  // 旧 Host 版本的 counts.visible 仍包含空会话；用实际分组重算，保证显示与列表一致。
  const visibleCount = state.workspaces.reduce(
    (sum, workspace) => sum + (workspace.sessions ?? []).filter((row) => row.blank !== true).length,
    0,
  ) + state.unassigned.filter((row) => row.blank !== true).length;
  if (sub !== null) {
    sub.textContent = `${visibleCount} 个会话 · ${state.workspaces.length} 个工作区`
      + `${state.archived.length > 0 ? ` · ${state.archived.filter((row) => row.blank !== true).length} 个已归档` : ''}`;
  }

  const totalSessions = groups.reduce((sum, group) => sum + group.sessions.length, 0);
  if (groups.length === 0 || (filter.length > 0 && totalSessions === 0)) {
    const empty = state.sessions.length === 0 && state.archived.length === 0;
    container.innerHTML = `<div class="empty"><div class="big">${empty ? '🫧' : '🔍'}</div><p>${empty ? '还没有会话。' : '没有匹配的会话。'}</p></div>`;
    return;
  }

  let html = '';
  for (const group of groups) {
    html += renderWorkspaceGroup(group, group.kind !== 'workspace');
  }
  container.innerHTML = html;
  for (const button of container.querySelectorAll('.ws-toggle')) {
    button.addEventListener('click', () => {
      const key = button.dataset.wsKey;
      if (state.collapsed.has(key)) state.collapsed.delete(key);
      else state.collapsed.add(key);
      localStorage.setItem('dsh_pocket_collapsed_ws', JSON.stringify([...state.collapsed]));
      renderSessionList();
    });
  }
  for (const button of container.querySelectorAll('.ws-add')) {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      void createSessionInWorkspace(button.dataset.wsPath);
    });
  }
  for (const button of container.querySelectorAll('.ws-files')) {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const path = button.dataset.wsFiles;
      if (typeof path !== 'string' || path.length === 0) return;
      openFileBrowser({ root: path, title: button.dataset.wsTitle || '工作区文件' });
    });
  }
  for (const button of container.querySelectorAll('.session')) {
    button.addEventListener('click', () => openSession(button.dataset.id));
  }
  for (const button of container.querySelectorAll('.session-more')) {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const row = findSessionRow(button.dataset.moreId);
      if (row !== undefined) openSessionMenu(row);
    });
  }
}

/**
 * 在已加载的列表数据里按 id 找会话行。
 * @param {string | undefined} id
 * @returns {any | undefined}
 */
function findSessionRow(id) {
  if (typeof id !== 'string' || id.length === 0) return undefined;
  const pools = [state.sessions, state.unassigned, state.archived];
  for (const workspace of state.workspaces) pools.push(workspace.sessions ?? []);
  for (const pool of pools) {
    const row = pool.find((item) => item.id === id);
    if (row !== undefined) return row;
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* 新建会话（工作区标题右侧的 +）                                                */
/* -------------------------------------------------------------------------- */

let creatingSession = false;

/**
 * 在指定工作区新建会话并直接打开。
 * @param {string | undefined} path
 * @returns {Promise<void>}
 */
async function createSessionInWorkspace(path) {
  if (typeof path !== 'string' || path.length === 0 || creatingSession) return;
  creatingSession = true;
  try {
    const payload = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ cwd: path }),
    });
    openSession(payload.sessionId);
  } catch (error) {
    toast(error.message ?? String(error));
  } finally {
    creatingSession = false;
  }
}

/* -------------------------------------------------------------------------- */
/* 会话操作（会话行右侧的“更多”）                                                */
/* -------------------------------------------------------------------------- */

/**
 * 打开某个会话的操作菜单。
 * @param {any} row
 */
function openSessionMenu(row) {
  const archived = row.archived === true;
  const pinned = row.pinned === true;
  const mask = el('div', 'modal-mask');
  const modal = el('div', 'modal sheet menu-sheet');
  const pinItem = archived
    ? ''
    : `<button class="menu-item" data-menu-action="pin" role="menuitem">
        ${ICONS.pin}
        <span class="menu-label">${pinned ? '取消置顶' : '置顶会话'}</span>
        ${pinned ? '' : '<span class="menu-hint">工作区内置顶</span>'}
      </button>`;
  modal.innerHTML = `
    <div class="sheet-head">
      <h3 class="menu-title">${escapeHtml(row.title ?? '会话')}</h3>
      <button class="iconbtn" data-menu-close title="关闭" aria-label="关闭">${ICONS.close}</button>
    </div>
    <div class="menu-list" role="menu">
      ${pinItem}
      <button class="menu-item" data-menu-action="rename" role="menuitem">${ICONS.edit}<span class="menu-label">重命名</span></button>
      <button class="menu-item" data-menu-action="archive" role="menuitem">${ICONS.archive}<span class="menu-label">${archived ? '取消归档' : '归档会话'}</span></button>
      <button class="menu-item" data-menu-action="copy" role="menuitem">${ICONS.copy}<span class="menu-label">复制 Session ID</span></button>
    </div>`;
  mask.appendChild(modal);
  document.body.appendChild(mask);
  const close = () => mask.remove();
  mask.addEventListener('click', (event) => {
    if (event.target === mask) close();
  });
  modal.querySelector('[data-menu-close]').addEventListener('click', close);
  for (const button of modal.querySelectorAll('[data-menu-action]')) {
    button.addEventListener('click', () => {
      close();
      const action = button.dataset.menuAction;
      if (action === 'pin') void togglePinned(row);
      else if (action === 'rename') openRenameDialog(row);
      else if (action === 'archive') void archiveSession(row);
      else if (action === 'copy') void copySessionId(row);
    });
  }
}

/**
 * 把 Host 的失败翻译成手机上看得懂的提示。
 * @param {any} error
 * @returns {string}
 */
function actionErrorText(error) {
  if (error?.code === 'workspace/session-active') return '会话还有工作在跑，归档前需要先停止它们';
  if (error?.code === 'session/not-found') return '会话不存在或已被移除';
  if (error?.code === 'workspace/not-found') return '工作区不存在';
  if (error?.code === 'session/title-invalid') return '这个标题不可用';
  return error?.message ?? String(error);
}

/**
 * 置顶 / 取消置顶。置顶只在会话所属工作区内生效，不会跨工作区排序。
 * @param {any} row
 * @returns {Promise<void>}
 */
async function togglePinned(row) {
  const pinned = row.pinned !== true;
  try {
    await api(`/api/sessions/${encodeURIComponent(row.id)}/pin`, {
      method: 'POST',
      body: JSON.stringify({ pinned }),
    });
    toast(pinned ? '已置顶（仅在此工作区内）' : '已取消置顶', 'ok');
    await refreshSessionsQuietly();
  } catch (error) {
    toast(actionErrorText(error));
  }
}

/**
 * 归档 / 取消归档。运行中的会话先问一句，Host 仍拒绝时再给出“停止并归档”。
 * @param {any} row
 * @returns {Promise<void>}
 */
async function archiveSession(row) {
  const request = (stopActivity) => api(`/api/sessions/${encodeURIComponent(row.id)}/archive`, {
    method: 'POST',
    body: JSON.stringify(stopActivity ? { stopActivity: true } : {}),
  });
  if (row.archived === true) {
    try {
      await api(`/api/sessions/${encodeURIComponent(row.id)}/unarchive`, { method: 'POST' });
      toast('已取消归档', 'ok');
      await refreshSessionsQuietly();
    } catch (error) {
      toast(actionErrorText(error));
    }
    return;
  }
  if (row.running === true) {
    const confirmed = await confirmDialog({
      title: '归档会话',
      message: '这个会话正在运行，归档会先停止当前工作。继续吗？',
      confirmText: '停止并归档',
    });
    if (!confirmed) return;
  }
  try {
    await request(row.running === true);
    toast('已归档', 'ok');
    await refreshSessionsQuietly();
  } catch (error) {
    if (error.code !== 'workspace/session-active') {
      toast(actionErrorText(error));
      return;
    }
    const confirmed = await confirmDialog({
      title: '会话还有工作在跑',
      message: '归档前需要先停止这些工作（回合、子代理、后台任务或定时提醒）。停止并归档？',
      confirmText: '停止并归档',
    });
    if (!confirmed) return;
    try {
      await request(true);
      toast('已归档', 'ok');
      await refreshSessionsQuietly();
    } catch (retryError) {
      toast(actionErrorText(retryError));
    }
  }
}

/**
 * 重命名对话框；确认未修改的标题会把当前标题固定下来。
 * @param {any} row
 */
function openRenameDialog(row) {
  const mask = el('div', 'modal-mask');
  const modal = el('div', 'modal');
  modal.innerHTML = `
    <h3>重命名会话</h3>
    <p>确认未改动的标题会把当前标题固定下来，不再被自动标题覆盖。</p>
    <input id="rename-input" maxlength="200" autocomplete="off" value="${escapeHtml(row.title ?? '')}">
    <div class="modal-actions">
      <button class="btn" id="rename-cancel">取消</button>
      <button class="btn primary" id="rename-save">保存</button>
    </div>`;
  mask.appendChild(modal);
  document.body.appendChild(mask);
  const input = modal.querySelector('#rename-input');
  const save = modal.querySelector('#rename-save');
  const close = () => mask.remove();
  mask.addEventListener('click', (event) => {
    if (event.target === mask) close();
  });
  modal.querySelector('#rename-cancel').addEventListener('click', close);
  const submit = async () => {
    const value = input.value.trim();
    if (value.length === 0) {
      toast('标题不能为空');
      input.focus();
      return;
    }
    save.disabled = true;
    save.textContent = '保存中…';
    try {
      await api(`/api/sessions/${encodeURIComponent(row.id)}/rename`, {
        method: 'POST',
        body: JSON.stringify({ title: value }),
      });
      close();
      toast('已重命名', 'ok');
      await refreshSessionsQuietly();
    } catch (error) {
      save.disabled = false;
      save.textContent = '保存';
      toast(actionErrorText(error));
    }
  };
  save.addEventListener('click', () => void submit());
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void submit();
    }
  });
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

/**
 * 复制会话 id（桌面端菜单里的同一项）。
 * @param {any} row
 * @returns {Promise<void>}
 */
async function copySessionId(row) {
  const copied = await writeClipboard(row.id);
  toast(copied ? '已复制 Session ID' : '复制失败，请长按标题手动复制', copied ? 'ok' : 'error');
}

/**
 * 写剪贴板：优先 Clipboard API，非安全上下文回退到 execCommand。
 * @param {string} text
 * @returns {Promise<boolean>}
 */
async function writeClipboard(text) {
  try {
    if (navigator.clipboard?.writeText !== undefined) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 继续走回退 */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    return copied;
  } catch {
    return false;
  }
}

/**
 * 简单确认框。
 * @param {{ title: string, message: string, confirmText?: string }} options
 * @returns {Promise<boolean>}
 */
function confirmDialog({ title, message, confirmText = '确定' }) {
  return new Promise((resolve) => {
    const mask = el('div', 'modal-mask');
    const modal = el('div', 'modal');
    modal.innerHTML = `
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(message)}</p>
      <div class="modal-actions">
        <button class="btn" data-confirm="no">取消</button>
        <button class="btn primary" data-confirm="yes">${escapeHtml(confirmText)}</button>
      </div>`;
    mask.appendChild(modal);
    document.body.appendChild(mask);
    const finish = (value) => {
      mask.remove();
      resolve(value);
    };
    mask.addEventListener('click', (event) => {
      if (event.target === mask) finish(false);
    });
    modal.querySelector('[data-confirm="no"]').addEventListener('click', () => finish(false));
    modal.querySelector('[data-confirm="yes"]').addEventListener('click', () => finish(true));
  });
}

/* -------------------------------------------------------------------------- */
/* 聊天                                                                        */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* 工作区文件树 / 预览                                                          */
/* -------------------------------------------------------------------------- */

/**
 * 文件浏览器状态。首页入口只读；会话入口额外支持把文件作为 @ 引用插入输入框。
 * 一次只保留一个覆盖层：sheet 是文件树，preview 叠在它上面。
 */
const fileBrowser = {
  sessionId: '',
  root: '',
  rootLabel: '',
  path: '',
  entries: [],
  truncated: false,
  loading: false,
  error: '',
  request: 0,
  sheet: null,
  preview: null,
};

/**
 * 文件接口前缀：会话内用 cwd，首页用已登记的工作区根目录。
 * @returns {string}
 */
function fileApiBase() {
  return fileBrowser.sessionId.length > 0
    ? `/api/sessions/${encodeURIComponent(fileBrowser.sessionId)}`
    : '/api/workspace';
}

/**
 * @param {'files' | 'text'} kind
 * @param {string} path
 * @returns {string}
 */
function fileApiUrl(kind, path) {
  const params = new URLSearchParams({ path: path ?? '' });
  if (fileBrowser.sessionId.length === 0) params.set('root', fileBrowser.root);
  return `${fileApiBase()}/${kind}?${params.toString()}`;
}

/**
 * 图片预览直接走二进制文件接口；HTML 里不能带请求头，所以令牌放 query。
 * @param {string} path
 * @returns {string}
 */
function fileImageUrl(path) {
  const params = new URLSearchParams({ path });
  if (fileBrowser.sessionId.length === 0) params.set('root', fileBrowser.root);
  params.set('token', token);
  return `${fileApiBase()}/file?${params.toString()}`;
}

/**
 * 打开工作区文件树。
 * @param {{ sessionId?: string, root?: string, title?: string }} options
 */
function openFileBrowser(options = {}) {
  if (document.querySelector('#file-sheet') !== null) closeFileBrowser();
  fileBrowser.sessionId = typeof options.sessionId === 'string' ? options.sessionId : '';
  fileBrowser.root = typeof options.root === 'string' ? options.root : '';
  fileBrowser.rootLabel = typeof options.title === 'string' && options.title.length > 0 ? options.title : '工作区文件';
  fileBrowser.path = '';
  fileBrowser.entries = [];
  fileBrowser.truncated = false;
  fileBrowser.loading = true;
  fileBrowser.error = '';
  fileBrowser.request += 1;

  const sheet = el('div', 'file-sheet');
  sheet.id = 'file-sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-label', fileBrowser.rootLabel);
  sheet.innerHTML = `
    <header class="file-top">
      <button class="iconbtn" id="file-back" title="返回" aria-label="返回">${ICONS.back}</button>
      <div class="file-heading">
        <b id="file-title">${escapeHtml(fileBrowser.rootLabel)}</b>
        <span id="file-root">${escapeHtml(fileBrowser.root || '正在读取工作区…')}</span>
      </div>
      <button class="iconbtn" id="file-refresh" title="刷新" aria-label="刷新">${ICONS.refresh}</button>
      <button class="iconbtn" id="file-close" title="关闭" aria-label="关闭">${ICONS.close}</button>
    </header>
    <div class="file-crumbs" id="file-crumbs"></div>
    <div class="file-list" id="file-list"></div>`;
  document.body.appendChild(sheet);
  fileBrowser.sheet = sheet;

  sheet.querySelector('#file-back').addEventListener('click', () => {
    if (fileBrowser.path.length > 0) void loadFileDirectory(fileBrowserParentPath(fileBrowser.path));
    else closeFileBrowser();
  });
  sheet.querySelector('#file-close').addEventListener('click', () => closeFileBrowser());
  sheet.querySelector('#file-refresh').addEventListener('click', () => void loadFileDirectory(fileBrowser.path));
  // 事件挂在 sheet 上：列表和面包屑都会被重绘，委托监听器不用重新绑定。
  sheet.addEventListener('click', (event) => {
    const retry = event.target.closest?.('[data-file-retry]');
    if (retry !== null && retry !== undefined) {
      void loadFileDirectory(fileBrowser.path);
      return;
    }
    const nav = event.target.closest?.('[data-file-nav]');
    if (nav !== null && nav !== undefined) {
      void loadFileDirectory(nav.dataset.fileNav ?? '');
      return;
    }
    const more = event.target.closest?.('[data-file-more]');
    if (more !== null && more !== undefined) {
      const entry = fileBrowser.entries.find((item) => item.path === more.dataset.fileMore);
      if (entry !== undefined) openFileActions(entry);
      return;
    }
    const open = event.target.closest?.('[data-file-open]');
    if (open === null || open === undefined) return;
    const entry = fileBrowser.entries.find((item) => item.path === open.dataset.fileOpen);
    if (entry === undefined) return;
    if (entry.kind === 'dir') void loadFileDirectory(entry.path);
    else openFilePreview(entry);
  });
  renderFileBrowser();
  void loadFileDirectory('');
}

function closeFileBrowser() {
  fileBrowser.request += 1;
  fileBrowser.sheet?.remove();
  fileBrowser.sheet = null;
  fileBrowser.sessionId = '';
  fileBrowser.root = '';
  fileBrowser.entries = [];
  fileBrowser.path = '';
  fileBrowser.error = '';
}

/**
 * @param {string} path
 * @returns {string}
 */
function fileBrowserParentPath(path) {
  const parts = String(path ?? '').split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

/**
 * @param {string} path
 * @returns {Promise<void>}
 */
async function loadFileDirectory(path) {
  const request = ++fileBrowser.request;
  fileBrowser.loading = true;
  fileBrowser.error = '';
  renderFileBrowser();
  try {
    const payload = await api(fileApiUrl('files', path));
    if (request !== fileBrowser.request || fileBrowser.sheet === null) return;
    if (typeof payload.root === 'string' && payload.root.length > 0) fileBrowser.root = payload.root;
    fileBrowser.path = typeof payload.path === 'string' ? payload.path : '';
    fileBrowser.entries = Array.isArray(payload.entries) ? payload.entries : [];
    fileBrowser.truncated = payload.truncated === true;
    fileBrowser.loading = false;
    renderFileBrowser();
    fileBrowser.sheet.querySelector('#file-list')?.scrollTo?.({ top: 0 });
  } catch (error) {
    if (request !== fileBrowser.request || fileBrowser.sheet === null) return;
    fileBrowser.loading = false;
    fileBrowser.entries = [];
    fileBrowser.error = error.message ?? String(error);
    renderFileBrowser();
  }
}

function renderFileBrowser() {
  const sheet = fileBrowser.sheet;
  if (sheet === null) return;
  const title = sheet.querySelector('#file-title');
  if (title !== null) title.textContent = fileBrowser.rootLabel;
  const root = sheet.querySelector('#file-root');
  if (root !== null) root.textContent = fileBrowser.root || '正在读取工作区…';

  const crumbs = sheet.querySelector('#file-crumbs');
  if (crumbs !== null) crumbs.innerHTML = fileCrumbHtml();

  const list = sheet.querySelector('#file-list');
  if (list === null) return;
  if (fileBrowser.loading) {
    list.innerHTML = '<div class="file-boot">正在读取目录…</div>';
    return;
  }
  if (fileBrowser.error.length > 0) {
    list.innerHTML = `
      <div class="file-note error">
        <div>${escapeHtml(fileBrowser.error)}</div>
        <button class="btn" data-file-retry>重试</button>
      </div>`;
    return;
  }
  if (fileBrowser.entries.length === 0) {
    list.innerHTML = `<div class="file-empty"><div class="big">${ICONS.folder}</div><p>这个目录是空的</p></div>`;
    return;
  }
  let html = '';
  for (const entry of fileBrowser.entries) {
    const isDir = entry.kind === 'dir';
    const meta = isDir
      ? '文件夹'
      : `${formatBytes(entry.size)}${entry.image === true ? ' · 图片' : entry.text === false ? ' · 二进制' : ''}`;
    html += `
      <div class="file-row">
        <button class="file-main" data-file-open="${escapeHtml(entry.path)}">
          <span class="file-glyph${isDir ? ' dir' : ''}">${isDir ? ICONS.folder : ICONS.file}</span>
          <span class="file-body">
            <span class="file-name">${escapeHtml(entry.name)}${isDir ? '/' : ''}</span>
            <span class="file-meta">${escapeHtml(meta)}</span>
          </span>
          <span class="file-chevron">${isDir ? ICONS.chevron : ''}</span>
        </button>
        <button class="file-more" data-file-more="${escapeHtml(entry.path)}" title="更多操作" aria-label="更多操作">${ICONS.more}</button>
      </div>`;
  }
  if (fileBrowser.truncated) {
    html += '<div class="file-note">目录项太多，只显示前 1000 项。</div>';
  }
  list.innerHTML = html;
}

/**
 * 面包屑：根是当前工作区，逐级可点。
 * @returns {string}
 */
function fileCrumbHtml() {
  let html = '<button class="file-crumb" data-file-nav="">工作区</button>';
  let accumulated = '';
  for (const part of fileBrowser.path.split('/').filter(Boolean)) {
    accumulated = accumulated.length === 0 ? part : `${accumulated}/${part}`;
    html += `<span class="file-crumb-sep">/</span><button class="file-crumb" data-file-nav="${escapeHtml(accumulated)}">${escapeHtml(part)}</button>`;
  }
  return html;
}

/**
 * 单行的“更多”菜单：预览、复制相对/完整路径、引用。
 * @param {any} entry
 */
function openFileActions(entry) {
  const isDir = entry.kind === 'dir';
  const refItem = fileBrowser.sessionId.length > 0
    ? `<button class="menu-item" data-file-action="reference" role="menuitem">${ICONS.chat}<span class="menu-label">引用到输入框</span></button>`
    : '';
  const mask = el('div', 'modal-mask');
  const modal = el('div', 'modal sheet menu-sheet');
  modal.innerHTML = `
    <div class="sheet-head">
      <h3 class="menu-title">${escapeHtml(entry.name)}</h3>
      <button class="iconbtn" data-file-action="close" title="关闭" aria-label="关闭">${ICONS.close}</button>
    </div>
    <div class="menu-list" role="menu">
      <button class="menu-item" data-file-action="${isDir ? 'open' : 'preview'}" role="menuitem">
        ${isDir ? ICONS.folder : ICONS.file}<span class="menu-label">${isDir ? '打开文件夹' : '预览文件'}</span>
      </button>
      <button class="menu-item" data-file-action="copy" role="menuitem">${ICONS.copy}<span class="menu-label">复制路径</span></button>
      <button class="menu-item" data-file-action="copy-full" role="menuitem">${ICONS.copy}<span class="menu-label">复制完整路径</span></button>
      ${refItem}
    </div>`;
  mask.appendChild(modal);
  document.body.appendChild(mask);
  const close = () => mask.remove();
  mask.addEventListener('click', (event) => {
    if (event.target === mask) close();
  });
  for (const button of modal.querySelectorAll('[data-file-action]')) {
    button.addEventListener('click', () => {
      const action = button.dataset.fileAction;
      if (action === 'close') {
        close();
        return;
      }
      close();
      if (action === 'open') void loadFileDirectory(entry.path);
      else if (action === 'preview') openFilePreview(entry);
      else if (action === 'copy') void copyFilePath(entry.path);
      else if (action === 'copy-full') void copyFilePath(fileFullPath(entry.path));
      else if (action === 'reference') insertFileReference(entry.path, isDir);
    });
  }
}

/**
 * @param {string} path
 * @returns {string}
 */
function fileFullPath(path) {
  const root = fileBrowser.root.replace(/[\\/]+$/u, '');
  const relative = String(path ?? '').replace(/^[\\/]+/u, '');
  return relative.length === 0 ? root : `${root}/${relative}`;
}

/**
 * @param {string} path
 * @returns {Promise<void>}
 */
async function copyFilePath(path) {
  const copied = await writeClipboard(path);
  toast(copied ? `已复制 ${path}` : '复制失败，请手动选择路径', copied ? 'ok' : 'error');
}

/**
 * 打开文件预览；文本用等宽 <pre>，图片走二进制接口，二进制给出说明。
 * @param {any} entry
 */
async function openFilePreview(entry) {
  closeFilePreview();
  const layer = el('div', 'file-preview');
  layer.id = 'file-preview';
  layer.setAttribute('role', 'dialog');
  layer.innerHTML = `
    <header class="file-top">
      <button class="iconbtn" id="preview-back" title="返回" aria-label="返回">${ICONS.back}</button>
      <div class="file-heading">
        <b id="preview-name">${escapeHtml(entry.name)}</b>
        <span id="preview-path">${escapeHtml(entry.path)}</span>
      </div>
      <button class="iconbtn" id="preview-close" title="关闭" aria-label="关闭">${ICONS.close}</button>
    </header>
    <div class="file-preview-scroll" id="preview-body"><div class="file-boot">正在读取文件…</div></div>
    <footer class="file-actions">
      <button class="btn" id="preview-copy">复制路径</button>
      ${fileBrowser.sessionId.length > 0 ? '<button class="btn primary" id="preview-ref">引用到输入框</button>' : ''}
    </footer>`;
  document.body.appendChild(layer);
  fileBrowser.preview = layer;
  const close = () => closeFilePreview();
  layer.querySelector('#preview-back').addEventListener('click', close);
  layer.querySelector('#preview-close').addEventListener('click', close);
  layer.querySelector('#preview-copy').addEventListener('click', () => void copyFilePath(entry.path));
  layer.querySelector('#preview-ref')?.addEventListener('click', () => insertFileReference(entry.path, false));

  let payload;
  try {
    payload = await api(fileApiUrl('text', entry.path));
  } catch (error) {
    if (fileBrowser.preview !== layer) return;
    const body = layer.querySelector('#preview-body');
    body.innerHTML = `<div class="file-note error">${escapeHtml(error.message ?? String(error))}</div>`;
    return;
  }
  if (fileBrowser.preview !== layer) return;
  const body = layer.querySelector('#preview-body');
  const name = layer.querySelector('#preview-name');
  const pathEl = layer.querySelector('#preview-path');
  if (name !== null) name.textContent = basename(payload.path ?? entry.path);
  if (pathEl !== null) pathEl.textContent = payload.path ?? entry.path;
  body.replaceChildren();
  const meta = el('div', 'file-preview-meta');
  meta.textContent = `${formatBytes(payload.size)}${payload.truncated === true ? ' · 已截断，仅显示前 400 KB' : ''}`;
  body.appendChild(meta);

  if (payload.image === true) {
    const image = new Image();
    image.className = 'file-image';
    image.alt = basename(entry.path);
    image.loading = 'lazy';
    image.src = fileImageUrl(entry.path);
    image.addEventListener('error', () => {
      const note = el('div', 'file-note error', '图片加载失败，可能超过 25 MB 或格式不受支持。');
      body.appendChild(note);
    });
    body.appendChild(image);
    return;
  }
  if (payload.binary === true) {
    body.appendChild(el('div', 'file-note', '这是二进制文件，手机端不预览内容。可以复制路径或引用给会话处理。'));
    return;
  }
  const pre = el('pre', 'file-text');
  pre.textContent = payload.content ?? '';
  body.appendChild(pre);
}

function closeFilePreview() {
  fileBrowser.preview?.remove();
  fileBrowser.preview = null;
}

/**
 * 把文件作为 DSH 的 `@path` 引用插入当前会话输入框；有空格时用引号形式。
 * @param {string} path
 * @param {boolean} isDir
 */
function insertFileReference(path, isDir) {
  const textarea = document.querySelector('#composer');
  if (state.current === undefined || textarea === null) {
    toast('请先进入一个会话再引用文件');
    return;
  }
  let target = String(path ?? '');
  if (target.length === 0) return;
  if (isDir && !target.endsWith('/')) target += '/';
  const mention = /\s/u.test(target) ? `@"${target.replaceAll('"', '\\"')}"` : `@${target}`;
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? start;
  const before = textarea.value.slice(0, start);
  const prefix = before.length > 0 && !/\s$/u.test(before) ? ' ' : '';
  textarea.setRangeText(`${prefix}${mention} `, start, end, 'end');
  textarea.focus();
  autosize(textarea);
  updateSendState();
  closeFilePreview();
  closeFileBrowser();
  toast('已引用到输入框', 'ok');
}

function closeChat() {
  closeFilePreview();
  closeFileBrowser();
  const current = state.current;
  state.current = undefined;
  state.pendingTexts = [];
  if (current !== undefined) {
    clearTimeout(current.reconnectTimer);
    clearInterval(current.questionTimer);
    clearTimeout(current.scrollTimer);
    clearTimeout(current.programmaticTimer);
    if (current.renderFrame !== 0) {
      clearTimeout(current.renderFrame);
      current.renderFrame = 0;
    }
    if (current.source !== undefined) {
      try {
        current.source.close();
      } catch {
        /* ignore */
      }
      current.source = undefined;
    }
  }
}

function openChat(id) {
  stopListTimer();
  if (state.current?.id === id) return;
  closeChat();
  state.view = 'chat';
  state.current = {
    id,
    meta: { sessionId: id, title: '会话', cwd: '', running: false },
    messages: [],
    toolResults: new Map(),
    openTools: new Set(),
    openReasoning: new Set(),
    closedReasoning: new Set(),
    images: [],
    controls: undefined,
    questions: [],
    interactions: [],
    questionTimer: undefined,
    features: undefined,
    seen: new Set(),
    minSeq: undefined,
    transient: undefined,
    running: false,
    hasMore: false,
    ready: false,
    snapshotLoading: false,
    nearBottom: true,
    scrolling: false,
    pendingMessages: false,
    pendingTransient: false,
    pendingRenderOptions: undefined,
    scrollTimer: undefined,
    programmaticScroll: false,
    programmaticTarget: 0,
    programmaticTimer: undefined,
    smoothScrolling: false,
    holdFollow: false,
    source: undefined,
    reconnectTimer: undefined,
    renderFrame: 0,
  };
  renderChatShell();
  renderAlerts();
  ensureEvents();
  void loadChatMeta(id);
  void loadCapabilities(id);
  void loadControls(id);
  startQuestionPolling(id);
  connectStream(id);
}

async function loadChatMeta(id) {
  try {
    const payload = await api(`/api/sessions/${encodeURIComponent(id)}`);
    const current = state.current;
    if (current?.id !== id) return;
    current.meta = payload.session;
    current.running = payload.session.running === true;
    updateChatHeader();
  } catch {
    /* hello 帧会再给一次 */
  }
}

function renderChatShell() {
  const current = state.current;
  app.innerHTML = `
    <header class="topbar">
      <button class="iconbtn" id="chat-back" title="返回">${ICONS.back}</button>
      <div class="topbar-title">
        <b id="chat-title">${escapeHtml(current.meta.title)}</b>
        <span id="chat-cwd">${escapeHtml(current.meta.cwd || '')}</span>
      </div>
      <button class="iconbtn" id="chat-files" title="工作区文件" aria-label="工作区文件" style="display:none">${ICONS.folder}</button>
      <button class="iconbtn theme-toggle" title="主题"></button>
      <span class="status-dot busy" id="chat-status" title="连接中"></span>
      <button class="iconbtn" id="chat-refresh" title="重新连接">${ICONS.refresh}</button>
    </header>
    <div class="chat-scroll" id="chat-scroll">
      <div class="msg-list" id="msg-list">
        <div class="boot" style="height:180px"><div class="boot-logo"></div><div class="boot-text">正在打开会话…</div></div>
      </div>
    </div>
    <div class="composer">
      <button class="scroll-bottom" id="scroll-bottom" hidden title="回到底部" aria-label="滚动到底部">${ICONS.chevronDown}</button>
      <div class="question-dock" id="question-dock"></div>
      <div class="composer-box">
        <div class="composer-tools">
          <button class="toolbtn" id="attach-image" title="添加图片">${ICONS.image}</button>
          <button class="toolbtn" id="open-controls" title="模型 / 权限 / 技能">${ICONS.sliders}</button>
          <span class="composer-chip" id="model-chip" style="display:none"></span>
        </div>
        <div class="image-strip" id="image-strip" hidden></div>
        <div class="composer-row">
          <textarea id="composer" rows="1" placeholder="发消息给 DSH…"></textarea>
          <button class="stop" id="stop" title="停止" style="display:none">${ICONS.stop}</button>
          <button class="send" id="send" title="发送" disabled>${ICONS.send}</button>
        </div>
        <input type="file" id="image-input" accept="image/*" multiple hidden>
      </div>
    </div>`;
  document.querySelector('#chat-back').addEventListener('click', () => {
    window.location.hash = '#/';
  });
  document.querySelector('#chat-refresh').addEventListener('click', () => {
    reloadChat();
  });
  document.querySelector('#chat-files').addEventListener('click', () => {
    const current = state.current;
    if (current === undefined) return;
    openFileBrowser({
      sessionId: current.id,
      title: current.meta.cwd ? basename(current.meta.cwd) : '工作区文件',
    });
  });
  const textarea = document.querySelector('#composer');
  textarea.addEventListener('input', () => {
    autosize(textarea);
    updateSendState();
  });
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void sendMessage();
    }
  });
  document.querySelector('#send').addEventListener('click', () => void sendMessage());
  document.querySelector('#stop').addEventListener('click', () => void stopTurn());
  document.querySelector('#attach-image').addEventListener('click', () => {
    document.querySelector('#image-input')?.click();
  });
  document.querySelector('#image-input').addEventListener('change', (event) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    void addImages(files);
  });
  document.querySelector('#open-controls').addEventListener('click', () => void openControlsSheet());
  document.querySelector('#model-chip').addEventListener('click', () => void openControlsSheet());
  document.querySelector('#question-dock').addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-question-action]');
    if (button !== null && button !== undefined) openQuestionModal();
  });
  document.querySelector('#image-strip').addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-image-index]');
    if (button === null || button === undefined) return;
    const index = Number(button.dataset.imageIndex);
    state.current?.images.splice(index, 1);
    renderImageStrip();
    updateSendState();
  });
  const scroll = document.querySelector('#chat-scroll');
  scroll.addEventListener('pointerdown', () => markUserScrolling(), { passive: true });
  scroll.addEventListener('touchstart', () => markUserScrolling(), { passive: true });
  scroll.addEventListener('touchmove', () => markUserScrolling(), { passive: true });
  scroll.addEventListener('wheel', () => markUserScrolling(), { passive: true });
  scroll.addEventListener('scroll', () => handleChatScroll());
  document.querySelector('#scroll-bottom').addEventListener('click', () => jumpToBottom());
  autosize(textarea);
  updateSendState();
  bindThemeButtons();
}

function autosize(textarea) {
  if (textarea === null) return;
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, 132)}px`;
}

/* -------------------------------------------------------------------------- */
/* 会话控件：模型 / 权限 / 技能 / 图片 / 问题                                   */
/* -------------------------------------------------------------------------- */

/**
 * 读取当前 Host 是否支持新控件（模型/权限/技能/图片/问题）。
 * 旧版插件没有 features 字段时隐藏这些入口，避免点了报 404。
 * @param {string} id
 * @returns {Promise<void>}
 */
async function loadCapabilities(id) {
  try {
    const status = await api('/api/status');
    const current = state.current;
    if (current?.id !== id) return;
    current.features = status.features ?? {};
    if (status.features !== undefined) state.features = status.features;
    const display = normalizeDisplaySettings(status.display);
    if (display !== undefined) state.display = display;
    updateDisplaySettingsEntry();
    const tools = document.querySelector('.composer-tools');
    if (tools !== null) tools.style.display = status.features?.controls === true ? 'flex' : 'none';
    const filesButton = document.querySelector('#chat-files');
    if (filesButton !== null) filesButton.style.display = status.features?.fileTree === true ? 'inline-flex' : 'none';
    if (status.features?.controls === true) updateModelChip();
    if (status.features?.notifications === true) ensureEvents();
    else disconnectEvents();
    if (status.features?.questions !== true) {
      clearInterval(current.questionTimer);
      current.questions = [];
      renderQuestionDock();
    }
  } catch {
    /* 状态读取失败时保持旧版简洁输入框 */
  }
}

/**
 * 读取会话控件数据（模型目录、权限预置、可见技能）。
 * @param {string} id
 * @returns {Promise<void>}
 */
async function loadControls(id) {
  try {
    const payload = await api(`/api/sessions/${encodeURIComponent(id)}/controls`);
    const current = state.current;
    if (current?.id !== id) return;
    current.controls = payload;
    updateModelChip();
  } catch {
    /* 控件是可选的，不影响聊天 */
  }
}

/**
 * 把当前模型/思考等级显示在输入框上方。
 */
function updateModelChip() {
  const chip = document.querySelector('#model-chip');
  if (chip === null) return;
  const current = state.current;
  const selection = current?.controls?.model?.selection;
  if (selection === undefined || selection === null) {
    chip.textContent = '';
    chip.style.display = 'none';
    return;
  }
  const catalog = current?.controls?.model?.catalog;
  let label = selection.model;
  for (const group of catalog?.groups ?? []) {
    const model = group.models.find((item) => item.id === selection.model);
    if (model !== undefined) {
      label = model.name;
      break;
    }
  }
  if (typeof selection.reasoningEffort === 'string' && selection.reasoningEffort.length > 0) {
    const model = (catalog?.groups ?? []).flatMap((group) => group.models).find((item) => item.id === selection.model);
    const effort = model?.reasoning?.efforts?.find((item) => item.id === selection.reasoningEffort);
    label += ` · ${effort?.name ?? selection.reasoningEffort}`;
  }
  chip.textContent = label;
  chip.title = `${selection.provider}/${selection.model}`;
  chip.style.display = '';
}

/**
 * 在光标处插入文本（技能选择用）。
 * @param {string} text
 */
function insertComposerText(text) {
  const textarea = document.querySelector('#composer');
  if (textarea === null) return;
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  textarea.value = `${textarea.value.slice(0, start)}${text}${textarea.value.slice(end)}`;
  const cursor = start + text.length;
  textarea.setSelectionRange(cursor, cursor);
  textarea.focus();
  autosize(textarea);
  updateSendState();
}

/**
 * 首页「显示与截断设置」入口的显隐；旧 Host 没有该能力时不显示。
 */
function updateDisplaySettingsEntry() {
  const button = document.querySelector('#settings-entry');
  if (button === null) return;
  // 设置页里还有纯本机的主题/列表设置，不依赖 Host 是否支持截断。
  button.style.display = 'flex';
}

/** 设置页的标签页；顺序与文案固定，未知值回退到截断。 */
const SETTINGS_TABS = [
  { id: 'appearance', label: '外观' },
  { id: 'list', label: '列表' },
  { id: 'truncate', label: '截断' },
];
const SETTINGS_TAB_KEY = 'dsh_pocket_settings_tab';

/**
 * 打开手机端设置。外观/列表只影响本机页面，截断设置与桌面 Pocket 面板共用。
 */
function openDisplaySettings() {
  const supportsDisplay = state.features?.displaySettings === true;
  const tabs = SETTINGS_TABS.filter((tab) => tab.id !== 'truncate' || supportsDisplay);
  const draft = {
    display: { ...state.display },
    theme: themeMode,
  };
  let initialTab = localStorage.getItem(SETTINGS_TAB_KEY) ?? 'truncate';
  if (!tabs.some((tab) => tab.id === initialTab)) initialTab = tabs[0]?.id ?? 'appearance';

  const themeOptions = [
    { value: 'system', label: '跟随系统', icon: ICONS.autoTheme },
    { value: 'light', label: '浅色', icon: ICONS.sun },
    { value: 'dark', label: '深色', icon: ICONS.moon },
  ];
  const themeButtons = themeOptions.map((option) => `
    <button class="theme-choice" data-theme-mode="${option.value}">
      <span class="theme-choice-icon">${option.icon}</span>
      <span>${option.label}</span>
    </button>`).join('');

  const mask = el('div', 'modal-mask');
  const modal = el('div', 'modal sheet settings-sheet');
  modal.innerHTML = `
    <div class="sheet-head">
      <h3>设置</h3>
      <button class="iconbtn" id="display-close" title="关闭" aria-label="关闭">${ICONS.close}</button>
    </div>
    <div class="settings-tabs" role="tablist">
      ${tabs.map((tab) => `<button class="settings-tab" role="tab" data-settings-tab="${tab.id}">${tab.label}</button>`).join('')}
    </div>
    <div class="sheet-scroll">
      <section class="settings-panel" data-settings-panel="appearance">
        <div class="sheet-label">主题</div>
        <div class="theme-choices" id="settings-theme">${themeButtons}</div>
        <div class="sheet-hint">同时应用到首页和聊天页；顶栏的主题按钮也会同步。</div>
      </section>
      <section class="settings-panel" data-settings-panel="list">
        <div class="sheet-label">会话列表</div>
        <div class="display-options">
          <label class="display-option">
            <span class="display-option-text"><b>显示已归档会话</b><span>在首页列出已归档的会话</span></span>
            <input type="checkbox" id="settings-archived"${state.showArchived ? ' checked' : ''}>
          </label>
        </div>
        <div class="sheet-hint">与首页顶栏的归档按钮同步；隐藏后仍可从桌面端取消归档。</div>
      </section>
      ${supportsDisplay ? `
      <section class="settings-panel" data-settings-panel="truncate">
        <div class="sheet-label">长内容截断</div>
        <div class="display-options">
          <label class="display-option">
            <span class="display-option-text"><b>工具输出</b><span>工具结果与调用参数</span></span>
            <input type="checkbox" id="display-tools"${draft.display.truncateTools ? ' checked' : ''}>
          </label>
          <label class="display-option">
            <span class="display-option-text"><b>Agent 回复</b><span>助手的正文内容</span></span>
            <input type="checkbox" id="display-assistant"${draft.display.truncateAssistant ? ' checked' : ''}>
          </label>
          <label class="display-option">
            <span class="display-option-text"><b>思考过程</b><span>reasoning 内容</span></span>
            <input type="checkbox" id="display-reasoning"${draft.display.truncateReasoning ? ' checked' : ''}>
          </label>
        </div>
        <div class="sheet-label" style="margin-top:6px">截断长度</div>
        <div class="display-length">
          <input class="sheet-input" id="display-limit" type="number" inputmode="numeric" min="${DISPLAY_LIMIT_MIN}" max="${DISPLAY_LIMIT_MAX}" step="500" value="${draft.display.limit}">
          <span>字符</span>
        </div>
        <div class="sheet-hint">超过上限的内容会显示截断标记，完整内容仍保存在会话里。关闭截断后长输出会完整传到手机，可能变慢。</div>
      </section>` : ''}
    </div>
    <div class="modal-actions">
      <button class="btn" id="display-cancel">取消</button>
      <button class="btn primary" id="display-save">保存</button>
    </div>`;
  mask.appendChild(modal);
  document.body.appendChild(mask);
  const close = () => mask.remove();
  mask.addEventListener('click', (event) => {
    if (event.target === mask) close();
  });
  modal.querySelector('#display-close').addEventListener('click', close);
  modal.querySelector('#display-cancel').addEventListener('click', close);

  const tabButtons = [...modal.querySelectorAll('[data-settings-tab]')];
  const panels = [...modal.querySelectorAll('[data-settings-panel]')];
  const selectTab = (id, persist = true) => {
    for (const button of tabButtons) button.classList.toggle('on', button.dataset.settingsTab === id);
    for (const panel of panels) panel.hidden = panel.dataset.settingsPanel !== id;
    if (persist) {
      try {
        localStorage.setItem(SETTINGS_TAB_KEY, id);
      } catch {
        /* private mode */
      }
    }
  };
  for (const button of tabButtons) {
    button.addEventListener('click', () => selectTab(button.dataset.settingsTab));
  }
  selectTab(initialTab, false);

  const themeChoices = [...modal.querySelectorAll('[data-theme-mode]')];
  const paintThemeChoices = () => {
    for (const button of themeChoices) button.classList.toggle('on', button.dataset.themeMode === draft.theme);
  };
  for (const button of themeChoices) {
    button.addEventListener('click', () => {
      draft.theme = button.dataset.themeMode;
      paintThemeChoices();
    });
  }
  paintThemeChoices();

  modal.querySelector('#display-save').addEventListener('click', async () => {
    let nextDisplay;
    if (supportsDisplay) {
      const limit = Number(modal.querySelector('#display-limit').value);
      if (!Number.isFinite(limit) || limit < DISPLAY_LIMIT_MIN || limit > DISPLAY_LIMIT_MAX) {
        toast(`截断长度需在 ${DISPLAY_LIMIT_MIN}–${DISPLAY_LIMIT_MAX} 字符之间`);
        selectTab('truncate');
        return;
      }
      const button = modal.querySelector('#display-save');
      button.disabled = true;
      button.textContent = '保存中…';
      try {
        const payload = await api('/api/display', {
          method: 'POST',
          body: JSON.stringify({
            truncateTools: modal.querySelector('#display-tools').checked,
            truncateAssistant: modal.querySelector('#display-assistant').checked,
            truncateReasoning: modal.querySelector('#display-reasoning').checked,
            limit,
          }),
        });
        nextDisplay = normalizeDisplaySettings(payload.display);
      } catch (error) {
        button.disabled = false;
        button.textContent = '保存';
        toast(error.message ?? String(error));
        return;
      }
    }

    if (draft.theme !== themeMode) setThemeMode(draft.theme);
    const showArchived = modal.querySelector('#settings-archived').checked;
    if (showArchived !== state.showArchived) {
      state.showArchived = showArchived;
      try {
        localStorage.setItem('dsh_pocket_show_archived', state.showArchived ? '1' : '0');
      } catch {
        /* private mode */
      }
      if (state.view === 'list') {
        renderShell();
        bindListEvents();
        renderSessionList();
      }
    }
    if (nextDisplay !== undefined) {
      state.display = nextDisplay;
      if (state.current !== undefined) reloadChat();
    }
    close();
    toast('设置已保存', 'ok');
  });
}

/**
 * 重新拉取当前会话历史；显示/截断设置改变后用它丢掉旧的截断数据。
 */
function reloadChat() {
  const current = state.current;
  if (current === undefined) return;
  closeChatSource();
  current.seen.clear();
  current.messages = [];
  current.toolResults.clear();
  current.openTools.clear();
  current.openReasoning.clear();
  current.closedReasoning.clear();
  current.minSeq = undefined;
  current.ready = false;
  current.snapshotLoading = true;
  current.scrolling = false;
  current.pendingMessages = false;
  current.pendingTransient = false;
  current.pendingRenderOptions = undefined;
  current.nearBottom = true;
  current.holdFollow = false;
  clearTimeout(current.scrollTimer);
  clearTimeout(current.programmaticTimer);
  renderMessages();
  connectStream(current.id);
}

/**
 * 打开模型 / 权限 / 技能设置面板。
 * @returns {Promise<void>}
 */
async function openControlsSheet() {
  const current = state.current;
  if (current === undefined) return;
  if (current.features?.controls !== true) {
    toast('重启 DSH 后可修改模型、权限与技能');
    return;
  }
  if (current.controls === undefined) await loadControls(current.id);
  const controls = current.controls;
  if (controls === undefined) {
    toast('会话设置读取失败');
    return;
  }

  const catalog = controls.model?.catalog;
  const initial = controls.model?.selection ?? catalog?.default ?? undefined;
  const choices = [];
  let activeIndex = -1;
  for (const group of catalog?.groups ?? []) {
    for (const model of group.models) {
      choices.push({ provider: group.id, model, groupName: group.name });
      if (initial !== undefined && initial.provider === group.id && initial.model === model.id) {
        activeIndex = choices.length - 1;
      }
    }
  }
  if (activeIndex < 0 && choices.length > 0) activeIndex = 0;

  const permissionOptions = controls.permissions?.catalog?.options ?? [];
  const currentPermission = controls.permissions?.current
    ?? controls.permissions?.catalog?.defaultPreset
    ?? permissionOptions[0]?.value
    ?? '';
  const skills = Array.isArray(controls.skills) ? controls.skills : [];

  const mask = el('div', 'modal-mask');
  const modal = el('div', 'modal sheet');
  modal.innerHTML = `
    <div class="sheet-head">
      <h3>会话设置</h3>
      <button class="iconbtn" id="sheet-close" title="关闭">${ICONS.close}</button>
    </div>
    <div class="sheet-scroll">
      <section class="sheet-section">
        <div class="sheet-label">模型</div>
        <select id="control-model" class="sheet-select"></select>
        <div class="effort-row" id="control-effort"></div>
      </section>
      <section class="sheet-section">
        <div class="sheet-label">权限</div>
        <select id="control-permission" class="sheet-select"></select>
        <div class="sheet-hint" id="control-permission-hint"></div>
      </section>
      <section class="sheet-section">
        <div class="sheet-label">技能</div>
        <input id="control-skill-search" class="sheet-input" placeholder="搜索技能…" autocomplete="off">
        <div class="skill-list" id="control-skills"></div>
      </section>
      <section class="sheet-section">
        <div class="sheet-label">手机</div>
        <button class="btn" id="open-display-settings">设置</button>
      </section>
    </div>
    <div class="modal-actions">
      <button class="btn" id="control-cancel">关闭</button>
      <button class="btn primary" id="control-save">保存</button>
    </div>`;
  mask.appendChild(modal);
  document.body.appendChild(mask);

  const close = () => mask.remove();
  mask.addEventListener('click', (event) => {
    if (event.target === mask) close();
  });
  modal.querySelector('#sheet-close').addEventListener('click', close);
  modal.querySelector('#control-cancel').addEventListener('click', close);
  modal.querySelector('#open-display-settings')?.addEventListener('click', () => {
    close();
    openDisplaySettings();
  });

  const modelSelect = modal.querySelector('#control-model');
  choices.forEach((choice, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = `${choice.groupName} · ${choice.model.name}`;
    modelSelect.appendChild(option);
  });
  modelSelect.value = String(Math.max(0, activeIndex));
  modelSelect.disabled = choices.length === 0;
  let draftIndex = Math.max(0, activeIndex);
  let draftEffort = typeof initial?.reasoningEffort === 'string' ? initial.reasoningEffort : '';

  const effortRow = modal.querySelector('#control-effort');
  const renderEfforts = () => {
    effortRow.replaceChildren();
    const choice = choices[draftIndex];
    const efforts = choice?.model?.reasoning?.efforts;
    if (!Array.isArray(efforts) || efforts.length === 0) {
      draftEffort = '';
      return;
    }
    const options = [{ id: '', name: '默认' }, ...efforts];
    for (const effort of options) {
      const button = el('button', `effort-chip${draftEffort === effort.id ? ' on' : ''}`);
      button.textContent = effort.name;
      button.title = effort.description ?? '';
      button.addEventListener('click', () => {
        draftEffort = effort.id;
        renderEfforts();
      });
      effortRow.appendChild(button);
    }
  };
  renderEfforts();
  modelSelect.addEventListener('change', () => {
    draftIndex = Number(modelSelect.value);
    const choice = choices[draftIndex];
    draftEffort = choice?.model?.reasoning?.defaultEffort ?? '';
    renderEfforts();
  });

  const permissionSelect = modal.querySelector('#control-permission');
  for (const option of permissionOptions) {
    const node = document.createElement('option');
    node.value = option.value;
    node.textContent = option.name || option.value;
    permissionSelect.appendChild(node);
  }
  if (currentPermission.length > 0 && !permissionOptions.some((option) => option.value === currentPermission)) {
    const node = document.createElement('option');
    node.value = currentPermission;
    node.textContent = '当前自定义设置';
    permissionSelect.appendChild(node);
  }
  permissionSelect.value = currentPermission;
  const permissionHint = modal.querySelector('#control-permission-hint');
  const renderPermissionHint = () => {
    const selected = permissionOptions.find((option) => option.value === permissionSelect.value);
    permissionHint.textContent = selected?.description ?? '';
  };
  renderPermissionHint();
  permissionSelect.addEventListener('change', renderPermissionHint);

  const skillSearch = modal.querySelector('#control-skill-search');
  const skillList = modal.querySelector('#control-skills');
  const renderSkills = () => {
    const filter = skillSearch.value.trim().toLowerCase();
    const matched = skills.filter((skill) => {
      if (filter.length === 0) return true;
      return `${skill.name ?? ''} ${skill.description ?? ''} ${skill.whenToUse ?? ''}`.toLowerCase().includes(filter);
    });
    if (matched.length === 0) {
      skillList.innerHTML = '<div class="sheet-hint">没有匹配的技能</div>';
      return;
    }
    skillList.innerHTML = matched.map((skill) => `
      <button class="skill-item" data-skill-name="${escapeHtml(skill.name)}">
        <span class="skill-name">/${escapeHtml(skill.name)}</span>
        <span class="skill-desc">${escapeHtml(skill.description ?? '')}</span>
      </button>`).join('');
    for (const button of skillList.querySelectorAll('.skill-item')) {
      button.addEventListener('click', () => {
        insertComposerText(`/${button.dataset.skillName} `);
        close();
      });
    }
  };
  skillSearch.addEventListener('input', renderSkills);
  renderSkills();

  modal.querySelector('#control-save').addEventListener('click', async () => {
    const choice = choices[draftIndex];
    if (choice === undefined) {
      close();
      return;
    }
    const button = modal.querySelector('#control-save');
    button.disabled = true;
    button.textContent = '保存中…';
    try {
      await api(`/api/sessions/${encodeURIComponent(current.id)}/model`, {
        method: 'POST',
        body: JSON.stringify({
          provider: choice.provider,
          model: choice.model.id,
          ...(draftEffort.length === 0 ? {} : { reasoningEffort: draftEffort }),
        }),
      });
      if (permissionSelect.value !== (controls.permissions?.current ?? '')) {
        await api(`/api/sessions/${encodeURIComponent(current.id)}/permissions`, {
          method: 'POST',
          body: JSON.stringify({ preset: permissionSelect.value }),
        });
      }
      close();
      toast('已保存', 'ok');
      await loadControls(current.id);
    } catch (error) {
      button.disabled = false;
      button.textContent = '保存';
      toast(error.message ?? String(error));
    }
  });
}

/* -------------------------------------------------------------------------- */
/* 问题回答                                                                    */
/* -------------------------------------------------------------------------- */

function startQuestionPolling(id) {
  const current = state.current;
  if (current === undefined || current.id !== id) return;
  clearInterval(current.questionTimer);
  void loadQuestions(id);
  current.questionTimer = setInterval(() => {
    if (document.visibilityState === 'visible' && state.current?.id === id) void loadQuestions(id);
  }, 3000);
}

async function loadQuestions(id) {
  try {
    const payload = await api(`/api/sessions/${encodeURIComponent(id)}/questions`);
    const current = state.current;
    if (current?.id !== id) return;
    current.questions = Array.isArray(payload.active) ? payload.active : [];
    renderQuestionDock();
  } catch {
    /* 问题投影不可用时静默 */
  }
}

function renderQuestionDock() {
  const dock = document.querySelector('#question-dock');
  if (dock === null) return;
  const current = state.current;
  const active = current?.questions ?? [];
  const interactions = current?.interactions ?? [];
  const continued = active.filter((item) => item.state === 'continued');
  const openQuestions = interactions.filter((item) => item.type === 'question');
  const approvals = interactions.filter((item) => item.type === 'approval');
  const answerable = continued.length + openQuestions.length + approvals.length;
  if (answerable === 0) {
    if (active.length === 0) {
      dock.replaceChildren();
      return;
    }
    const waiting = el('div', 'question-banner waiting');
    waiting.innerHTML = `${ICONS.question}<span>有 ${active.length} 个问题等待工具结束</span>`;
    dock.replaceChildren(waiting);
    return;
  }
  const parts = [];
  if (approvals.length > 0) parts.push(`${approvals.length} 个审批`);
  if (openQuestions.length > 0) parts.push(`${openQuestions.length} 个提问`);
  if (continued.length > 0) parts.push(`${continued.length} 个待回答`);
  const button = el('button', 'question-banner');
  button.dataset.questionAction = 'open';
  button.innerHTML = `${ICONS.question}<span>${parts.join(' · ')}</span><span class="pill run">处理</span>`;
  dock.replaceChildren(button);
}

/**
 * 把手机端的回答通过会话 WebSocket 发回 Host。
 * @param {object} message
 * @returns {boolean}
 */
function sendInteraction(message) {
  const socket = state.current?.source;
  if (socket === undefined || socket.readyState !== 1) return false;
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

function dropInteraction(requestId) {
  const current = state.current;
  if (current === undefined) return;
  current.interactions = (current.interactions ?? []).filter((item) => item.requestId !== requestId);
  renderQuestionDock();
}

function openQuestionModal() {
  const current = state.current;
  if (current === undefined) return;
  const approval = (current.interactions ?? []).find((item) => item.type === 'approval');
  if (approval !== undefined) {
    openApprovalModal(approval);
    return;
  }
  const openQuestion = (current.interactions ?? []).find((item) => item.type === 'question');
  const call = openQuestion ?? (current.questions ?? []).find((item) => item.state === 'continued');
  if (call === undefined) {
    toast('当前没有可回答的问题');
    return;
  }
  const questions = Array.isArray(call.questions) ? call.questions : [];
  const isOpen = typeof call.requestId === 'string';
  const mask = el('div', 'modal-mask');
  const modal = el('div', 'modal sheet');
  modal.innerHTML = `
    <div class="sheet-head">
      <h3>${isOpen ? '工具正在等待回答' : '回答提问'}</h3>
      <button class="iconbtn" id="question-close" title="关闭">${ICONS.close}</button>
    </div>
    <div class="sheet-scroll" id="question-form"></div>
    <div class="modal-actions">
      <button class="btn" id="question-cancel">取消</button>
      <button class="btn primary" id="question-submit">提交回答</button>
    </div>`;
  mask.appendChild(modal);
  document.body.appendChild(mask);
  const form = modal.querySelector('#question-form');
  questions.forEach((question, index) => {
    const section = el('section', 'question-item');
    const header = question.header ? `<div class="question-header">${escapeHtml(question.header)}</div>` : '';
    const detail = question.detail ? `<div class="question-detail">${escapeHtml(question.detail).replaceAll('\n', '<br>')}</div>` : '';
    const options = Array.isArray(question.options) ? question.options : [];
    const type = question.multiSelect === true ? 'checkbox' : 'radio';
    section.innerHTML = `
      ${header}
      <div class="question-text">${escapeHtml(question.question ?? '')}</div>
      ${detail}
      <div class="question-options">
        ${options.map((option, optionIndex) => `
          <label class="question-option">
            <input type="${type}" name="q-${index}" value="${escapeHtml(option.label)}" id="q-${index}-${optionIndex}">
            <span class="question-option-body">
              <span class="question-option-main">${escapeHtml(option.label)}</span>
              ${option.description ? `<span class="question-option-desc">${escapeHtml(option.description)}</span>` : ''}
            </span>
          </label>`).join('')}
      </div>
      <input class="sheet-input" data-custom-index="${index}" placeholder="${options.length > 0 ? '自定义回答（可选）' : '输入回答'}">
    `;
    form.appendChild(section);
  });
  const close = () => mask.remove();
  mask.addEventListener('click', (event) => {
    if (event.target === mask) close();
  });
  modal.querySelector('#question-close').addEventListener('click', close);
  modal.querySelector('#question-cancel').addEventListener('click', close);
  modal.querySelector('#question-submit').addEventListener('click', async () => {
    const answers = [];
    for (let index = 0; index < questions.length; index += 1) {
      const question = questions[index];
      const checked = [...modal.querySelectorAll(`input[name="q-${index}"]:checked`)].map((input) => input.value);
      const customInput = modal.querySelector(`[data-custom-index="${index}"]`);
      const custom = typeof customInput?.value === 'string' ? customInput.value.trim() : '';
      if (checked.length === 0 && custom.length === 0) {
        toast(`请回答第 ${index + 1} 个问题`);
        return;
      }
      const multi = question.multiSelect === true;
      answers.push({
        id: question.id,
        selected: multi ? checked : (custom.length > 0 ? [] : checked),
        ...(custom.length > 0 ? { custom } : {}),
      });
    }
    const submit = modal.querySelector('#question-submit');
    submit.disabled = true;
    submit.textContent = '提交中…';
    try {
      if (isOpen) {
        const sent = sendInteraction({ kind: 'question-answer', requestId: call.requestId, answers });
        if (!sent) {
          await api(`/api/sessions/${encodeURIComponent(current.id)}/interactions/${encodeURIComponent(call.requestId)}/answer`, {
            method: 'POST',
            body: JSON.stringify({ answers }),
          });
        }
        dropInteraction(call.requestId);
        toast('已提交回答', 'ok');
      } else {
        const result = await api(`/api/sessions/${encodeURIComponent(current.id)}/questions/${encodeURIComponent(call.callId)}/answer`, {
          method: 'POST',
          body: JSON.stringify({ answers }),
        });
        if (result.accepted === false) {
          toast('问题已经不可回答');
        } else {
          toast('已提交回答', 'ok');
        }
        await loadQuestions(current.id);
      }
      close();
    } catch (error) {
      submit.disabled = false;
      submit.textContent = '提交回答';
      toast(error.message ?? String(error));
    }
  });
}

/**
 * 工具审批：允许一次 / 拒绝。
 * @param {object} interaction
 */
function openApprovalModal(interaction) {
  const current = state.current;
  if (current === undefined) return;
  const mask = el('div', 'modal-mask');
  const modal = el('div', 'modal');
  const reason = interaction.displayReason ?? interaction.reason ?? '';
  modal.innerHTML = `
    <h3>工具审批</h3>
    <div class="question-text">${escapeHtml(interaction.toolName ?? '工具')}</div>
    ${reason ? `<div class="question-detail">${escapeHtml(reason).replaceAll('\n', '<br>')}</div>` : ''}
    <div class="sheet-hint">允许后只放行这一次调用；拒绝会以 fail-closed 结束本次请求。</div>
    <div class="modal-actions">
      <button class="btn" id="approval-reject">拒绝</button>
      <button class="btn primary" id="approval-allow">允许一次</button>
    </div>`;
  mask.appendChild(modal);
  document.body.appendChild(mask);
  const close = () => mask.remove();
  mask.addEventListener('click', (event) => {
    if (event.target === mask) close();
  });
  const answer = async (outcome) => {
    const allow = modal.querySelector('#approval-allow');
    const reject = modal.querySelector('#approval-reject');
    allow.disabled = true;
    reject.disabled = true;
    try {
      const sent = sendInteraction({ kind: 'approval-answer', requestId: interaction.requestId, outcome });
      if (!sent) {
        await api(`/api/sessions/${encodeURIComponent(current.id)}/interactions/${encodeURIComponent(interaction.requestId)}/answer`, {
          method: 'POST',
          body: JSON.stringify({ outcome }),
        });
      }
      dropInteraction(interaction.requestId);
      toast(outcome === 'allowed-once' ? '已允许一次' : '已拒绝', 'ok');
      close();
    } catch (error) {
      allow.disabled = false;
      reject.disabled = false;
      toast(error.message ?? String(error));
    }
  };
  modal.querySelector('#approval-allow').addEventListener('click', () => void answer('allowed-once'));
  modal.querySelector('#approval-reject').addEventListener('click', () => void answer('rejected'));
}

/* -------------------------------------------------------------------------- */
/* 图片                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 读取文件为 data URL。
 * @param {Blob} file
 * @returns {Promise<string>}
 */
function readFileAsDataUrl(file) {
  return new Promise((resolvePromise, rejectPromise) => {
    const reader = new FileReader();
    reader.onload = () => resolvePromise(String(reader.result ?? ''));
    reader.onerror = () => rejectPromise(reader.error ?? new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

/** 手机相册可能给出 HEIC/HEIF，统一按 MIME 或扩展名识别。 */
const IMAGE_TYPE_PATTERN = /^image\/(?:png|jpe?g|webp|gif|heic|heif|avif)$/u;

/**
 * 从文件名/MIME 推断图片类型；部分 Android 文件选择器不给 `file.type`。
 * @param {File} file
 * @returns {string}
 */
function detectImageType(file) {
  if (typeof file.type === 'string' && file.type.startsWith('image/')) return file.type.toLowerCase();
  const ext = String(file.name ?? '').split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'heic') return 'image/heic';
  if (ext === 'heif') return 'image/heif';
  if (ext === 'avif') return 'image/avif';
  return '';
}

/**
 * 得到可绘制到 canvas 的图片源。
 * @param {Blob} file
 * @returns {Promise<{ source: CanvasImageSource, width: number, height: number, close: () => void }>}
 */
async function loadImageSource(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close?.() };
    } catch {
      /* Safari 对 HEIC/AVIF 可能不支持 createImageBitmap，回退到 <img> */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolvePromise, rejectPromise) => {
      const node = new Image();
      node.onload = () => resolvePromise(node);
      node.onerror = () => rejectPromise(new Error('读取图片失败'));
      node.src = url;
    });
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      close: () => URL.revokeObjectURL(url),
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

/**
 * 把 canvas 导出成 JPEG Blob（旧 Safari 没有 toBlob 时走 toDataURL）。
 * @param {HTMLCanvasElement} canvas
 * @param {number} quality
 * @returns {Promise<Blob | null>}
 */
function canvasToBlob(canvas, quality) {
  return new Promise((resolvePromise) => {
    if (typeof canvas.toBlob === 'function') {
      canvas.toBlob((blob) => resolvePromise(blob), 'image/jpeg', quality);
      return;
    }
    try {
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      resolvePromise(new Blob([bytes], { type: 'image/jpeg' }));
    } catch {
      resolvePromise(null);
    }
  });
}

/**
 * 压缩手机照片：长边最多 2048px，目标 ≤ 1.5 MB。
 * 主要是为了穿过 Pocket 的 JSON 请求体和移动网络，而不是追求画质。
 * @param {File} file
 * @param {string} mediaType
 * @returns {Promise<Blob>}
 */
async function compressImage(file, mediaType) {
  const passthrough = (mediaType === 'image/jpeg' || mediaType === 'image/png' || mediaType === 'image/webp')
    && file.size <= 700_000;
  if (passthrough || mediaType === 'image/gif') return file;

  const loaded = await loadImageSource(file);
  try {
    if (loaded.width === 0 || loaded.height === 0) return file;
    const scale = Math.min(1, 2048 / Math.max(loaded.width, loaded.height));
    let width = Math.max(1, Math.round(loaded.width * scale));
    let height = Math.max(1, Math.round(loaded.height * scale));
    let quality = 0.9;
    let blob = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (context === null) break;
      // JPEG 没有 alpha；先铺白色，避免透明截图变成黑底。
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, width, height);
      context.drawImage(loaded.source, 0, 0, width, height);
      blob = await canvasToBlob(canvas, quality);
      if (blob === null) break;
      if (blob.size <= 1_500_000) break;
      if (width <= 900) {
        quality = Math.max(0.55, quality - 0.12);
      } else {
        width = Math.max(1, Math.round(width * 0.78));
        height = Math.max(1, Math.round(height * 0.78));
      }
    }
    return blob ?? file;
  } finally {
    loaded.close();
  }
}

async function addImages(files) {
  const current = state.current;
  if (current === undefined) return;
  if (current.features?.images !== true) {
    toast('重启 DSH 后可添加图片');
    return;
  }
  for (const file of files) {
    if (current.images.length >= 4) {
      toast('最多添加 4 张图片');
      break;
    }
    const mediaType = detectImageType(file);
    if (mediaType.length === 0) continue;
    if (!IMAGE_TYPE_PATTERN.test(mediaType)) {
      toast('只支持 png/jpeg/webp/gif/heic 图片');
      continue;
    }
    if (file.size > 18 * 1024 * 1024) {
      toast(`${file.name} 超过 18 MB`);
      continue;
    }
    try {
      const compressed = await compressImage(file, mediaType);
      if (compressed.size > 6 * 1024 * 1024) {
        toast(`${file.name} 压缩后仍超过 6 MB`);
        continue;
      }
      const outgoingType = compressed.type || mediaType;
      if (!/^image\/(?:png|jpe?g|webp|gif)$/u.test(outgoingType)) {
        toast('这个图片格式无法转换，请换一张');
        continue;
      }
      const dataUrl = await readFileAsDataUrl(compressed);
      current.images.push({
        mediaType: outgoingType,
        data: dataUrl.replace(/^data:[^;]+;base64,/u, ''),
        name: file.name,
        preview: dataUrl,
      });
    } catch (error) {
      toast(error.message ?? String(error));
    }
  }
  renderImageStrip();
  updateSendState();
}

function renderImageStrip() {
  const strip = document.querySelector('#image-strip');
  if (strip === null) return;
  const images = state.current?.images ?? [];
  strip.hidden = images.length === 0;
  strip.innerHTML = images.map((image, index) => `
    <div class="image-thumb">
      <img src="${image.preview}" alt="${escapeHtml(image.name ?? '图片')}">
      <button class="image-remove" data-image-index="${index}" title="移除">${ICONS.close}</button>
    </div>`).join('');
}

function updateSendState() {
  const textarea = document.querySelector('#composer');
  const send = document.querySelector('#send');
  const stop = document.querySelector('#stop');
  if (textarea === null || send === null) return;
  const hasText = textarea.value.trim().length > 0;
  const hasImages = (state.current?.images?.length ?? 0) > 0;
  send.disabled = !hasText && !hasImages;
  if (stop !== null) stop.style.display = state.current?.running === true ? 'flex' : 'none';
}

function updateChatHeader() {
  const current = state.current;
  if (current === undefined) return;
  const title = document.querySelector('#chat-title');
  const cwd = document.querySelector('#chat-cwd');
  const status = document.querySelector('#chat-status');
  if (title !== null) title.textContent = current.meta.title || '会话';
  if (cwd !== null) cwd.textContent = current.meta.cwd || '';
  if (status !== null) {
    status.className = `status-dot${state.connected ? (current.running ? ' busy' : '') : ' off'}`;
    status.title = state.connected ? (current.running ? '运行中' : '已连接') : '连接已断开';
  }
  updateSendState();
}

/**
 * 用户正在触摸/滚轮/惯性滚动：暂停重绘与自动吸底，避免流式内容抢滚动。
 * 滚动停止 220ms 后补一次渲染。
 */
function markUserScrolling() {
  const current = state.current;
  if (current === undefined) return;
  current.programmaticScroll = false;
  current.smoothScrolling = false;
  current.scrolling = true;
  clearTimeout(current.scrollTimer);
  current.scrollTimer = setTimeout(() => {
    if (state.current !== current) return;
    current.scrolling = false;
    flushDeferredRenders();
  }, 220);
}

/**
 * 只改滚动位置、不触发“用户正在滚动”的判定。
 * @param {HTMLElement} scroll
 * @param {number} top
 */
function applyScrollTop(scroll, top) {
  const current = state.current;
  const clamped = Math.max(0, Math.min(top, scroll.scrollHeight - scroll.clientHeight));
  if (current !== undefined) {
    current.programmaticScroll = true;
    current.programmaticTarget = clamped;
    clearTimeout(current.programmaticTimer);
    current.programmaticTimer = setTimeout(() => {
      if (state.current === current) current.programmaticScroll = false;
    }, 80);
  }
  scroll.scrollTop = clamped;
}

/** 聊天滚动位置变化：更新“是否在底部”，并进入用户滚动状态。 */
function handleChatScroll() {
  const scroll = document.querySelector('#chat-scroll');
  const current = state.current;
  if (scroll === null || current === undefined) return;
  const distance = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
  if (current.programmaticScroll === true) {
    const target = current.programmaticTarget;
    current.programmaticScroll = false;
    // 只有滚动位置确实是我们刚设置的值时才按程序化滚动处理。
    if (typeof target === 'number' && Math.abs(scroll.scrollTop - target) <= 2) {
      current.nearBottom = current.holdFollow === true ? false : distance < 140;
      syncScrollButton();
      return;
    }
  }
  if (current.smoothScrolling === true) {
    // 平滑回到底部期间忽略中间位置；用户一碰就会把 smoothScrolling 清掉。
    if (distance > 4) return;
    current.smoothScrolling = false;
  }
  current.nearBottom = distance < 140;
  if (current.nearBottom) current.holdFollow = false;
  syncScrollButton();
  markUserScrolling();
}

/** 用户停止滚动后，把期间排队的一次渲染补上。 */
function flushDeferredRenders() {
  const current = state.current;
  if (current === undefined) return;
  if (current.pendingMessages === true) {
    current.pendingMessages = false;
    current.pendingTransient = false;
    const options = current.pendingRenderOptions;
    current.pendingRenderOptions = undefined;
    renderMessages(options ?? {});
  } else if (current.pendingTransient === true) {
    current.pendingTransient = false;
    renderTransient();
  }
  if (current.nearBottom) scrollToBottom(false);
}

/**
 * 展开/收起消息里的 details 时暂时停住自动吸底，避免下一次流式帧把视图拉回底部。
 */
function holdChatScrollForInspection() {
  const current = state.current;
  if (current === undefined) return;
  current.nearBottom = false;
  current.holdFollow = true;
  current.scrolling = true;
  current.smoothScrolling = false;
  clearTimeout(current.scrollTimer);
  current.scrollTimer = setTimeout(() => {
    if (state.current !== current) return;
    current.scrolling = false;
    flushDeferredRenders();
  }, 600);
  syncScrollButton();
}

function scrollToBottom(force = false) {
  const scroll = document.querySelector('#chat-scroll');
  const current = state.current;
  if (scroll === null) return;
  if (force !== true && (current?.scrolling === true || current?.holdFollow === true)) return;
  if (force === true && current !== undefined) current.holdFollow = false;
  if (force || current?.nearBottom !== false) {
    if (current !== undefined) current.nearBottom = true;
    requestAnimationFrame(() => {
      const live = state.current;
      if (live === undefined) return;
      if (force !== true && (live.scrolling === true || live.nearBottom === false)) return;
      applyScrollTop(scroll, scroll.scrollHeight);
    });
  }
  syncScrollButton();
}

/** 同步“回到底部”按钮：只在用户翻到上面时出现。 */
function syncScrollButton() {
  const button = document.querySelector('#scroll-bottom');
  if (button === null) return;
  button.hidden = state.current?.nearBottom !== false;
}

/** 一键回到底部；优先平滑滚动，尊重“减少动态效果”。 */
function jumpToBottom() {
  const current = state.current;
  if (current !== undefined) {
    current.scrolling = false;
    current.holdFollow = false;
    current.pendingMessages = false;
    current.pendingTransient = false;
    clearTimeout(current.scrollTimer);
    flushDeferredRenders();
    current.nearBottom = true;
  }
  const scroll = document.querySelector('#chat-scroll');
  if (scroll !== null) {
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    if (current !== undefined) current.smoothScrolling = !reduceMotion && typeof scroll.scrollTo === 'function';
    if (reduceMotion || typeof scroll.scrollTo !== 'function') {
      applyScrollTop(scroll, scroll.scrollHeight);
    } else {
      scroll.scrollTo({ top: scroll.scrollHeight, behavior: 'smooth' });
    }
  }
  syncScrollButton();
}

/* -------------------------------------------------------------------------- */
/* 会话流（WebSocket）                                                          */
/* -------------------------------------------------------------------------- */

function closeChatSource() {
  const current = state.current;
  if (current === undefined) return;
  clearTimeout(current.reconnectTimer);
  const source = current.source;
  current.source = undefined;
  if (source !== undefined) {
    try {
      source.close();
    } catch {
      /* ignore */
    }
  }
}

function connectStream(id) {
  const current = state.current;
  if (current === undefined || current.id !== id) return;
  closeChatSource();

  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  let socket;
  try {
    socket = new WebSocket(`${scheme}://${window.location.host}/ws/session/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`);
  } catch (error) {
    state.connected = false;
    updateChatHeader();
    toast(error.message ?? String(error));
    return;
  }
  current.source = socket;

  socket.onopen = () => {
    if (state.current !== current) return;
    state.connected = true;
    updateChatHeader();
  };

  socket.onmessage = (event) => {
    if (state.current !== current) return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    switch (message.kind) {
      case 'hello':
        current.meta = { ...current.meta, ...message, title: message.title || current.meta.title };
        current.running = message.running === true;
        state.connected = true;
        updateChatHeader();
        break;
      case 'snapshot-meta':
        beginSnapshot(message);
        break;
      case 'snapshot-batch':
        applySnapshotBatch(message);
        break;
      case 'snapshot-end':
        endSnapshot();
        break;
      case 'frame':
        handleFrame(message.frame);
        break;
      case 'question-request': {
        current.interactions = current.interactions.filter((item) => item.requestId !== message.requestId);
        current.interactions.push({ ...message, type: 'question' });
        renderQuestionDock();
        break;
      }
      case 'approval-request': {
        current.interactions = current.interactions.filter((item) => item.requestId !== message.requestId);
        current.interactions.push({ ...message, type: 'approval' });
        renderQuestionDock();
        break;
      }
      case 'interaction-closed':
        current.interactions = current.interactions.filter((item) => item.requestId !== message.requestId);
        renderQuestionDock();
        break;
      case 'failed':
        toast(message.error ?? '会话流中断');
        break;
      default:
        break;
    }
  };

  socket.onerror = () => {
    if (state.current !== current) return;
    state.connected = false;
    updateChatHeader();
  };

  socket.onclose = () => {
    if (state.current !== current || current.source !== socket) return;
    current.source = undefined;
    state.connected = false;
    updateChatHeader();
    // 令牌轮换后 WebSocket 会一直失败；探一次状态以触发解锁页。
    void api('/api/status').catch(() => {});
    clearTimeout(current.reconnectTimer);
    if (state.view === 'chat' && state.current === current) {
      current.reconnectTimer = setTimeout(() => {
        if (state.current === current && current.source === undefined) connectStream(id);
      }, 1500);
    }
  };
}

function handleFrame(frame) {
  const current = state.current;
  if (current === undefined) return;
  if (frame.type === 'snapshot') {
    applySnapshot(frame);
    return;
  }
  if (frame.type === 'event') {
    if (applyEvent(frame.event, current)) {
      renderMessages();
      scrollToBottom(false);
    }
    return;
  }
  if (frame.type === 'assistant-stream') {
    applyStream(frame.frame);
  }
}

/** 开始接收一次新的历史快照。 */
function beginSnapshot(meta) {
  const current = state.current;
  if (current === undefined) return;
  current.messages = [];
  current.toolResults = new Map();
  current.seen.clear();
  current.minSeq = undefined;
  current.transient = undefined;
  current.hasMore = meta?.hasMore === true;
  current.ready = false;
  current.snapshotLoading = true;
  renderMessages();
}

/** 追加一批历史记录；边收边渲染，避免手机长时间白屏。 */
function applySnapshotBatch(payload) {
  const current = state.current;
  if (current === undefined) return;
  for (const record of payload?.records ?? []) {
    if (record?.type === 'event') applyEvent(record.event, current);
  }
  current.snapshotLoading = false;
  renderMessages();
}

/** 历史快照接收完毕。 */
function endSnapshot() {
  const current = state.current;
  if (current === undefined) return;
  current.snapshotLoading = false;
  current.ready = true;
  renderMessages();
  renderTransient();
  scrollToBottom(true);
}

function applySnapshot(frame) {
  const current = state.current;
  if (current === undefined) return;
  current.messages = [];
  current.toolResults = new Map();
  current.seen.clear();
  current.minSeq = undefined;
  current.transient = undefined;
  current.hasMore = frame.hasMore === true;
  current.ready = true;
  current.snapshotLoading = false;
  for (const record of frame.records ?? []) {
    if (record?.type === 'event') applyEvent(record.event, current);
  }
  if (typeof frame.cursor === 'number' && Number.isFinite(frame.cursor)) {
    if (current.minSeq === undefined) current.minSeq = frame.cursor;
  }
  renderMessages();
  renderTransient();
  scrollToBottom(true);
}

function applyEvent(event, current, options = {}) {
  if (event === undefined || event === null) return false;
  const seq = typeof event.seq === 'number' ? event.seq : undefined;
  if (seq !== undefined) {
    if (current.seen.has(seq)) return false;
    current.seen.add(seq);
    if (current.minSeq === undefined || seq < current.minSeq) current.minSeq = seq;
  }

  const data = event.data ?? {};
  switch (event.type) {
    case 'turn/start':
      if (options.historical === true) return false;
      current.running = true;
      updateChatHeader();
      return true;
    case 'turn/end':
      if (options.historical === true) return false;
      current.running = false;
      current.transient = undefined;
      updateChatHeader();
      return true;
    case 'user/message': {
      if (data?.source?.kind !== 'user') return false;
      const text = blocksText(data.content);
      if (text.trim().length === 0 && !(data.content ?? []).some((block) => block.type === 'image' || block.type === 'file')) return false;
      const pendingIndex = current.messages.findIndex((message) => message.pending === true);
      if (pendingIndex >= 0) current.messages.splice(pendingIndex, 1);
      current.messages.push({
        kind: 'user',
        seq,
        time: event.time ?? Date.now(),
        blocks: data.content ?? [],
      });
      return true;
    }
    case 'assistant/message': {
      current.transient = undefined;
      const message = data.message;
      if (message === undefined || !Array.isArray(message.content)) return false;
      current.messages.push({
        kind: 'assistant',
        seq,
        time: event.time ?? Date.now(),
        blocks: message.content,
        interrupted: data.interrupted === true,
        usage: data.usage,
        source: message.source,
      });
      return true;
    }
    case 'tool/result': {
      const message = data.message;
      if (message === undefined) return false;
      const callId = message.toolCallId ?? message.source?.callId;
      if (typeof callId !== 'string') return false;
      current.toolResults.set(callId, {
        blocks: message.content ?? [],
        isError: message.isError === true || data.error !== undefined,
        time: event.time ?? Date.now(),
        error: data.error,
      });
      return true;
    }
    case 'session/title': {
      if (typeof data.title === 'string') {
        current.meta.title = data.title;
        updateChatHeader();
      }
      return false;
    }
    default:
      return false;
  }
}

function applyStream(frame) {
  const current = state.current;
  if (current === undefined) return;
  if (frame.type === 'start') {
    current.transient = { text: '', reasoning: '', tools: new Map(), active: true };
    renderTransient();
    return;
  }
  if (frame.type === 'end') {
    if (frame.outcome?.kind === 'abandoned') {
      current.transient = undefined;
      renderTransient();
    } else if (current.transient !== undefined) {
      current.transient.active = false;
      renderTransient();
    }
    return;
  }
  if (frame.type !== 'chunk') return;
  if (current.transient === undefined) current.transient = { text: '', reasoning: '', tools: new Map(), active: true };
  const transient = current.transient;
  const chunk = frame.chunk ?? {};
  switch (chunk.type) {
    case 'text-delta':
      transient.text += chunk.text ?? '';
      break;
    case 'reasoning-delta':
      transient.reasoning += chunk.text ?? '';
      break;
    case 'tool-call-delta': {
      const key = chunk.id ?? `index:${chunk.index}`;
      const existing = transient.tools.get(key) ?? { id: chunk.id, name: '', args: '' };
      if (typeof chunk.name === 'string' && chunk.name.length > 0) existing.name = chunk.name;
      existing.args += chunk.argumentsDelta ?? '';
      transient.tools.set(key, existing);
      break;
    }
    case 'block-end': {
      const block = chunk.block;
      if (block?.type === 'tool-call') {
        const key = block.id ?? `index:${chunk.index}`;
        transient.tools.set(key, { id: block.id, name: block.name ?? '', args: block.arguments ?? '' });
      }
      break;
    }
    default:
      break;
  }
  scheduleTransientRender();
}

function scheduleTransientRender() {
  const current = state.current;
  if (current === undefined) return;
  if (current.scrolling === true) {
    current.pendingTransient = true;
    return;
  }
  if (current.renderFrame !== 0) return;
  // 80ms 节流：流式 token 很密集，逐帧替换 DOM 会打断手机上的惯性滚动。
  current.renderFrame = setTimeout(() => {
    current.renderFrame = 0;
    if (state.current !== current) return;
    if (current.scrolling === true) {
      current.pendingTransient = true;
      return;
    }
    renderTransient();
    scrollToBottom(false);
  }, 80);
}

/* -------------------------------------------------------------------------- */
/* 渲染消息                                                                    */
/* -------------------------------------------------------------------------- */

function renderMessages(options = {}) {
  const current = state.current;
  if (current === undefined) return;
  if (current.scrolling === true) {
    current.pendingMessages = true;
    current.pendingRenderOptions = options;
    return;
  }
  const list = document.querySelector('#msg-list');
  if (list === null) return;

  const wasNearBottom = current.nearBottom;
  const scroll = document.querySelector('#chat-scroll');
  const previousHeight = scroll?.scrollHeight ?? 0;
  const previousTop = scroll?.scrollTop ?? 0;

  const fragment = document.createDocumentFragment();
  if (current.hasMore && current.messages.length > 0) {
    const more = el('button', 'loadmore', '加载更早的消息');
    more.addEventListener('click', () => void loadOlder(more));
    fragment.appendChild(more);
  }

  let lastTime = 0;
  for (const message of current.messages) {
    if (message.kind === 'user' || message.kind === 'assistant') {
      if (typeof message.time === 'number' && message.time - lastTime > 20 * 60_000) {
        const day = el('div', 'day');
        day.textContent = `${dayLabel(message.time)} ${clockTime(message.time)}`;
        fragment.appendChild(day);
        lastTime = message.time;
      }
      fragment.appendChild(message.kind === 'user' ? renderUserMessage(message) : renderAssistantMessage(message));
    }
  }

  if (current.messages.length === 0) {
    if (current.snapshotLoading === true) {
      fragment.appendChild(el('div', 'empty', '<div class="boot-logo" style="margin:0 auto 12px"></div><p>正在加载历史记录…</p>'));
    } else {
      fragment.appendChild(el('div', 'empty', '<div class="big">🫧</div><p>这个会话还没有消息。发第一条吧。</p>'));
    }
  }

  const slot = el('div');
  slot.id = 'transient-slot';
  fragment.appendChild(slot);
  fragment.appendChild(el('div', 'chat-end'));

  list.replaceChildren(fragment);
  renderTransientInto(slot);

  if (scroll !== null) {
    if (wasNearBottom) {
      applyScrollTop(scroll, scroll.scrollHeight);
    } else if (options.preserveGap === true && current.messages.length > 0 && previousHeight > 0) {
      // 往上加载历史时把新增内容留在视口上方，保持当前阅读位置。
      applyScrollTop(scroll, previousTop + (scroll.scrollHeight - previousHeight));
    } else {
      // 流式内容只会追加在底部；用户翻到上面时保持绝对滚动位置，不被持续推下去。
      applyScrollTop(scroll, previousTop);
    }
  }
}

function renderUserMessage(message) {
  const wrap = el('div', 'msg user');
  const bubble = el('div', `bubble${message.pending === true ? ' pending' : ''}`);
  let html = '';
  for (const block of message.blocks ?? []) {
    if (block.type === 'text') html += `<div>${escapeHtml(block.text ?? '').replaceAll('\n', '<br>')}</div>`;
    else if (block.type === 'image') {
      if (typeof block.dataUrl === 'string') {
        html += `<img src="${block.dataUrl}" alt="${escapeHtml(block.name ?? '图片')}" style="max-width:100%;border-radius:10px;display:block;margin:4px 0">`;
      } else {
        html += attachmentImage(message.sessionId ?? state.current?.id, block);
      }
    } else if (block.type === 'file') html += `<div class="pill">📎 ${escapeHtml(block.attachment?.name ?? '文件')}</div>`;
  }
  bubble.innerHTML = html.length > 0 ? html : '<span class="pill">空消息</span>';
  wrap.appendChild(bubble);
  if (typeof message.time === 'number') {
    const time = el('div', 'msg-time');
    time.textContent = message.pending === true ? '发送中…' : clockTime(message.time);
    wrap.appendChild(time);
  }
  return wrap;
}

function attachmentImage(sessionId, block) {
  const id = block.attachment?.attachmentId;
  if (typeof id !== 'string' || typeof sessionId !== 'string') return '<div class="pill">🖼 图片</div>';
  const src = `/api/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`;
  return `<img src="${src}" alt="图片" style="max-width:100%;border-radius:10px;display:block;margin:4px 0">`;
}

function renderAssistantMessage(message) {
  const wrap = el('div', 'msg assistant');
  const bubble = el('div', 'bubble');
  let toolSeen = false;
  const blocks = message.blocks ?? [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const blockKey = `${message.seq ?? message.time ?? 0}:${index}`;
    if (block.type === 'reasoning') {
      if ((block.text ?? '').trim().length === 0) continue;
      bubble.appendChild(reasoningNode(block.text, blockKey));
    } else if (block.type === 'text') {
      if ((block.text ?? '').trim().length === 0) continue;
      const md = el('div', 'md', renderMarkdown(truncateForDisplay(block.text, 'assistant')));
      bubble.appendChild(md);
    } else if (block.type === 'tool-call') {
      toolSeen = true;
      bubble.appendChild(toolNode(block, state.current?.toolResults.get(block.id), message.time, blockKey));
    } else if (block.type === 'image') {
      const holder = el('div');
      holder.innerHTML = attachmentImage(state.current?.id, block);
      bubble.appendChild(holder);
    }
  }
  if (message.interrupted === true) {
    const note = el('div', 'pill', '已中断');
    bubble.appendChild(note);
  }
  if (message.usage !== undefined) {
    const usage = message.usage;
    const text = `↑${usage.inputTokens ?? 0} · ↓${usage.outputTokens ?? 0}`;
    const note = el('div', 'msg-time');
    note.textContent = text;
    bubble.appendChild(note);
  }
  if (!toolSeen && bubble.childNodes.length === 0) {
    bubble.innerHTML = '<span class="pill">（空回复）</span>';
  }
  wrap.appendChild(bubble);
  if (typeof message.time === 'number') {
    const time = el('div', 'msg-time');
    time.textContent = clockTime(message.time);
    wrap.appendChild(time);
  }
  return wrap;
}

function reasoningNode(text, key, defaultOpen = false) {
  const details = el('details', 'thinking');
  const summary = el('summary');
  summary.textContent = '思考过程';
  const body = el('div', 'body');
  body.textContent = truncateForDisplay(text, 'reasoning');
  details.append(summary, body);
  // 记住展开状态：流式重绘 / 历史刷新时不要把用户展开的思考过程收回去。
  const openReasoning = state.current?.openReasoning;
  const closedReasoning = state.current?.closedReasoning;
  const rememberedOpen = key !== undefined && openReasoning?.has(key) === true;
  const rememberedClosed = key !== undefined && closedReasoning?.has(key) === true;
  const open = rememberedOpen || (defaultOpen && !rememberedClosed);
  if (open) details.open = true;
  let expectedOpen = open;
  details.addEventListener('toggle', () => {
    if (details.open === expectedOpen) return;
    expectedOpen = details.open;
    if (key !== undefined && openReasoning !== undefined) {
      if (details.open) {
        openReasoning.add(key);
        closedReasoning?.delete(key);
      } else {
        openReasoning.delete(key);
        closedReasoning?.add(key);
      }
    }
    holdChatScrollForInspection();
  });
  return details;
}

/**
 * 解析工具参数 JSON；失败时返回 undefined。
 * @param {any} call
 * @returns {any | undefined}
 */
function toolArguments(call) {
  try {
    const value = JSON.parse(call?.arguments ?? '');
    return value !== null && typeof value === 'object' ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 把多行文本压成一行并截断。
 * @param {string} value
 * @param {number} limit
 * @returns {string}
 */
function oneLine(value, limit) {
  const line = String(value ?? '').split(/\r?\n/u)[0].replace(/\s+/gu, ' ').trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/**
 * 工具折叠标题里的摘要：优先取命令/路径/查询，最后退回参数首行。
 * @param {any} call
 * @param {any} result
 * @returns {string}
 */
function toolSummary(call, result) {
  const args = toolArguments(call);
  const pick = (keys) => {
    if (args === undefined) return undefined;
    for (const key of keys) {
      const value = args[key];
      if (typeof value === 'string' && value.trim().length > 0) return value;
    }
    return undefined;
  };
  const command = pick(['command', 'cmd', 'script', 'commandLine']);
  if (command !== undefined) return oneLine(command, 84);
  const path = pick(['path', 'file_path', 'filePath', 'file', 'directory', 'target', 'cwd']);
  if (path !== undefined) return oneLine(path, 84);
  const query = pick(['query', 'pattern', 'url', 'name', 'description', 'prompt', 'goal', 'text']);
  if (query !== undefined) return oneLine(query, 84);
  const raw = String(call?.arguments ?? '').trim();
  if (raw.length > 0) return oneLine(raw, 84);
  if (result !== undefined) {
    const text = blocksText(result.blocks).trim();
    if (text.length > 0) return oneLine(text, 84);
  }
  return '点击展开详情';
}

function toolNode(call, result, time, key) {
  const node = el('details', 'tool');
  const head = el('summary', 'tool-head');
  head.appendChild(el('span', 'tool-icon', toolIcon(call.name)));
  const name = el('span', 'tool-name');
  name.textContent = call.name || 'tool';
  head.appendChild(name);
  const summary = el('span', 'tool-summary');
  summary.textContent = toolSummary(call, result);
  summary.title = summary.textContent;
  head.appendChild(summary);
  const stateNode = el('span', `tool-state ${result?.isError === true ? 'err' : result !== undefined ? 'ok' : 'run'}`);
  stateNode.textContent = result?.isError === true ? '失败' : result !== undefined ? '完成' : '运行中';
  head.appendChild(stateNode);
  head.appendChild(el('span', 'tool-caret', '›'));
  node.appendChild(head);

  const body = el('div', 'tool-body');
  const args = truncateForDisplay(prettyJson(call.arguments ?? ''), 'tool');
  if (args.trim().length > 0) {
    body.appendChild(el('div', 'tool-label', '参数'));
    body.appendChild(el('pre', '', escapeHtml(args)));
  }
  if (result !== undefined) {
    const text = truncateForDisplay(blocksText(result.blocks), 'tool');
    body.appendChild(el('div', 'tool-label', result.isError === true ? '错误' : '结果'));
    body.appendChild(el('pre', '', escapeHtml(text.length > 0 ? text : '（无文本输出）')));
  }
  node.appendChild(body);

  // 折叠状态按 callId 记住，SSE 重绘时不会把用户展开的卡片收回去。
  const id = typeof call.id === 'string' && call.id.length > 0
    ? call.id
    : typeof key === 'string'
      ? key
      : '';
  const openTools = state.current?.openTools;
  const open = id.length > 0 && openTools?.has(id) === true;
  if (open) node.open = true;
  let expectedOpen = open;
  node.addEventListener('toggle', () => {
    if (node.open === expectedOpen) return;
    expectedOpen = node.open;
    if (id.length > 0 && state.current?.openTools !== undefined) {
      if (node.open) state.current.openTools.add(id);
      else state.current.openTools.delete(id);
    }
    holdChatScrollForInspection();
  });
  return node;
}

function renderTransient() {
  const current = state.current;
  if (current === undefined) return;
  if (current.scrolling === true) {
    current.pendingTransient = true;
    return;
  }
  const slot = document.querySelector('#transient-slot');
  if (slot !== null) renderTransientInto(slot);
}

function renderTransientInto(slot) {
  const current = state.current;
  if (current === undefined) return;
  slot.replaceChildren();
  const transient = current.transient;
  if (transient === undefined) return;
  const hasContent = transient.text.length > 0 || transient.reasoning.length > 0 || transient.tools.size > 0;
  if (!hasContent) return;
  const wrap = el('div', 'msg assistant transient');
  const bubble = el('div', 'bubble');
  if (transient.reasoning.length > 0) {
    bubble.appendChild(reasoningNode(transient.reasoning, 'transient', true));
  }
  let toolIndex = 0;
  for (const tool of transient.tools.values()) {
    const key = typeof tool.id === 'string' && tool.id.length > 0 ? `stream:${tool.id}` : `stream:index:${toolIndex}`;
    bubble.appendChild(toolNode({ id: tool.id, name: tool.name || 'tool', arguments: tool.args }, undefined, undefined, key));
    toolIndex += 1;
  }
  if (transient.text.length > 0) {
    const md = el('div', 'md', renderMarkdown(truncateForDisplay(transient.text, 'assistant')));
    bubble.appendChild(md);
  }
  if (transient.active === true) {
    bubble.appendChild(el('span', 'caret'));
  }
  wrap.appendChild(bubble);
  slot.appendChild(wrap);
}

/* -------------------------------------------------------------------------- */
/* 历史翻页                                                                    */
/* -------------------------------------------------------------------------- */

async function loadOlder(button) {
  const current = state.current;
  if (current === undefined || current.minSeq === undefined) return;
  button.disabled = true;
  button.textContent = '加载中…';
  try {
    const through = Math.max(0, current.minSeq - 1);
    const payload = await api(`/api/sessions/${encodeURIComponent(current.id)}/page?throughSeq=${through}&beforeSeq=${current.minSeq}&maxMessages=50`);
    const records = payload.records ?? [];
    for (const record of records) {
      if (record?.type !== 'event') continue;
      const event = record.event;
      if (typeof event?.seq === 'number' && current.seen.has(event.seq)) continue;
      applyEvent(event, current, { historical: true });
    }
    current.hasMore = payload.hasMore === true;
    // applyEvent 已把旧消息 push 到尾部；按 seq 重排即可恢复时间顺序。
    current.messages.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    renderMessages({ preserveGap: true });
  } catch (error) {
    button.disabled = false;
    button.textContent = '加载更早的消息';
    toast(error.message ?? String(error));
  }
}

/* -------------------------------------------------------------------------- */
/* 发送 / 停止                                                                 */
/* -------------------------------------------------------------------------- */

async function sendMessage() {
  const current = state.current;
  if (current === undefined) return;
  const textarea = document.querySelector('#composer');
  if (textarea === null) return;
  const text = textarea.value.trim();
  const images = current.images.slice(0, 4);
  if (text.length === 0 && images.length === 0) return;

  textarea.value = '';
  current.images = [];
  renderImageStrip();
  autosize(textarea);
  updateSendState();

  const blocks = [];
  if (text.length > 0) blocks.push({ type: 'text', text });
  for (const image of images) {
    blocks.push({ type: 'image', dataUrl: image.preview, name: image.name });
  }
  const pending = {
    kind: 'user',
    pending: true,
    time: Date.now(),
    seq: Number.MAX_SAFE_INTEGER,
    blocks,
  };
  current.messages.push(pending);
  current.nearBottom = true;
  renderMessages();
  scrollToBottom(true);

  try {
    await api(`/api/sessions/${encodeURIComponent(current.id)}/prompt`, {
      method: 'POST',
      body: JSON.stringify({
        text,
        mode: 'auto',
        images: images.map((image) => ({
          mediaType: image.mediaType,
          data: image.data,
          name: image.name,
        })),
      }),
    });
  } catch (error) {
    const index = current.messages.indexOf(pending);
    if (index >= 0) current.messages.splice(index, 1);
    if (state.current === current) {
      current.images = images;
      if (textarea.value.length === 0) textarea.value = text;
      renderImageStrip();
      autosize(textarea);
      updateSendState();
    }
    renderMessages();
    toast(error.message ?? String(error));
  }
}

async function stopTurn() {
  const current = state.current;
  if (current === undefined) return;
  try {
    await api(`/api/sessions/${encodeURIComponent(current.id)}/cancel`, { method: 'POST', body: '{}' });
    toast('已请求停止', 'ok');
  } catch (error) {
    toast(error.message ?? String(error));
  }
}

/* -------------------------------------------------------------------------- */
/* 路由                                                                        */
/* -------------------------------------------------------------------------- */

function route() {
  const hash = window.location.hash;
  const match = /^#\/s\/(.+)$/u.exec(hash);
  if (match !== null) {
    openChat(decodeURIComponent(match[1]));
    return;
  }
  loadSessions();
}

window.addEventListener('hashchange', route);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (state.view === 'list') {
    void refreshSessionsQuietly();
    void ensureBalance(false);
  }
  ensureEvents();
});

if (token.length === 0) {
  showUnlock();
} else {
  route();
}

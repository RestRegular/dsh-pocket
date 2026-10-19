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
    throw new Error(payload.error ?? `HTTP ${response.status}`);
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
  question: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M9.5 9.2a2.6 2.6 0 0 1 5 .9c0 1.7-2.5 2.1-2.5 3.7"/><path d="M12 17.2h.01"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg>',
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
  state.view = 'unlock';
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
        <div class="brand-mark" aria-hidden="true"></div>
        <div>
          <div class="brand-name">Pocket</div>
          <div class="brand-sub" id="list-sub">正在读取会话…</div>
        </div>
      </div>
      <button class="iconbtn theme-toggle" title="主题"></button>
      <button class="iconbtn${state.showArchived ? ' active' : ''}" id="archived-toggle" title="${state.showArchived ? '隐藏已归档会话' : '显示已归档会话'}" aria-label="已归档">${ICONS.archive}</button>
      <button class="iconbtn" id="refresh" title="刷新">${ICONS.refresh}</button>
    </header>
    <div class="list-scroll" id="list-scroll">
      <div class="search">${ICONS.search}<input id="search" placeholder="搜索会话、工作区或目录" autocomplete="off"></div>
      <div id="session-list"></div>
    </div>`;
  bindThemeButtons();
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
  const search = document.querySelector('#search');
  if (search !== null) {
    search.value = state.filter;
    search.addEventListener('input', () => {
      state.filter = search.value.trim();
      renderSessionList();
    });
  }
}

async function refreshSessionsQuietly() {
  try {
    const payload = await api('/api/sessions');
    applySessionPayload(payload);
    state.connected = true;
    if (state.view === 'list') {
      renderSessionList();
    }
  } catch {
    state.connected = false;
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
  const sessions = [...group.sessions].sort((left, right) => {
    const pin = (right.pinned === true ? 1 : 0) - (left.pinned === true ? 1 : 0);
    if (pin !== 0) return pin;
    return (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
  });
  const addButton = group.kind === 'workspace' && typeof group.path === 'string' && group.path.length > 0
    ? `<button class="ws-add" data-ws-path="${escapeHtml(group.path)}" title="在此工作区新建会话" aria-label="在此工作区新建会话">${ICONS.plus}</button>`
    : '';
  let html = `
    <div class="ws-head ws-${escapeHtml(group.kind)}">
      <button class="ws-toggle" data-ws-key="${escapeHtml(key)}" aria-expanded="${String(!collapsed)}">
        <span class="ws-chevron">${collapsed ? ICONS.chevron : ICONS.chevronDown}</span>
        <span class="ws-icon">${icon}</span>
        <span class="ws-title">${escapeHtml(group.title)}</span>
        <span class="ws-count">${sessions.length}</span>
      </button>
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
  for (const item of sessions) {
    const pills = [
      item.running === true ? '<span class="pill run">运行中</span>' : '',
      item.pinned === true ? `<span class="pill pin">${ICONS.pin}置顶</span>` : '',
      group.kind === 'archived' ? '<span class="pill arc">已归档</span>' : '',
    ].filter(Boolean).join('');
    const meta = showPathInRows
      ? `<span class="session-meta"><span class="cwd">${escapeHtml(item.cwd || '未绑定目录')}</span></span>`
      : '';
    rows += `
      <button class="session${item.running === true ? ' running' : ''}${item.archived === true ? ' archived' : ''}" data-id="${escapeHtml(item.id)}">
        <span class="session-main">
          <span class="session-title"><span>${escapeHtml(item.title ?? '会话')}</span>${pills}</span>
          ${meta}
        </span>
        <span class="session-time">${escapeHtml(relativeTime(item.updatedAt))}</span>
      </button>`;
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
  for (const button of container.querySelectorAll('.session')) {
    button.addEventListener('click', () => openSession(button.dataset.id));
  }
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
/* 聊天                                                                        */
/* -------------------------------------------------------------------------- */

function closeChat() {
  const current = state.current;
  state.current = undefined;
  state.pendingTexts = [];
  if (current !== undefined) {
    clearTimeout(current.reconnectTimer);
    clearInterval(current.questionTimer);
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
    source: undefined,
    reconnectTimer: undefined,
    renderFrame: 0,
  };
  renderChatShell();
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
    if (state.current === undefined) return;
    closeChatSource();
    state.current.seen.clear();
    state.current.messages = [];
    state.current.toolResults.clear();
    state.current.minSeq = undefined;
    state.current.ready = false;
    state.current.snapshotLoading = true;
    renderMessages();
    connectStream(state.current.id);
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
  document.querySelector('#chat-scroll').addEventListener('scroll', () => {
    const scroll = document.querySelector('#chat-scroll');
    if (state.current !== undefined) {
      state.current.nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 140;
    }
  });
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
    const tools = document.querySelector('.composer-tools');
    if (tools !== null) tools.style.display = status.features?.controls === true ? 'flex' : 'none';
    if (status.features?.controls === true) updateModelChip();
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
            <span class="question-option-main">${escapeHtml(option.label)}</span>
            ${option.description ? `<span class="question-option-desc">${escapeHtml(option.description)}</span>` : ''}
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
 * @param {File} file
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
    if (!file.type.startsWith('image/')) continue;
    if (!/^image\/(?:png|jpe?g|webp|gif)$/u.test(file.type)) {
      toast('只支持 png/jpeg/webp/gif 图片');
      continue;
    }
    if (file.size > 18 * 1024 * 1024) {
      toast(`${file.name} 超过 18 MB`);
      continue;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      current.images.push({
        mediaType: file.type,
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

function scrollToBottom(force = false) {
  const scroll = document.querySelector('#chat-scroll');
  if (scroll === null) return;
  if (force || state.current?.nearBottom !== false) {
    requestAnimationFrame(() => {
      scroll.scrollTop = scroll.scrollHeight;
    });
  }
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
  if (current === undefined || current.renderFrame !== 0) return;
  current.renderFrame = requestAnimationFrame(() => {
    if (state.current !== current) return;
    current.renderFrame = 0;
    renderTransient();
    scrollToBottom(false);
  });
}

/* -------------------------------------------------------------------------- */
/* 渲染消息                                                                    */
/* -------------------------------------------------------------------------- */

function renderMessages() {
  const current = state.current;
  if (current === undefined) return;
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
      scroll.scrollTop = scroll.scrollHeight;
    } else if (current.messages.length > 0 && previousHeight > 0) {
      scroll.scrollTop = previousTop + (scroll.scrollHeight - previousHeight);
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
  for (const block of message.blocks ?? []) {
    if (block.type === 'reasoning') {
      if ((block.text ?? '').trim().length === 0) continue;
      bubble.appendChild(reasoningNode(block.text));
    } else if (block.type === 'text') {
      if ((block.text ?? '').trim().length === 0) continue;
      const md = el('div', 'md', renderMarkdown(block.text));
      bubble.appendChild(md);
    } else if (block.type === 'tool-call') {
      toolSeen = true;
      bubble.appendChild(toolNode(block, state.current?.toolResults.get(block.id), message.time));
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

function reasoningNode(text) {
  const details = el('details', 'thinking');
  const summary = el('summary');
  summary.textContent = '思考过程';
  const body = el('div', 'body');
  body.textContent = text;
  details.append(summary, body);
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

function toolNode(call, result, time) {
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
  const args = prettyJson(call.arguments ?? '');
  if (args.trim().length > 0) {
    body.appendChild(el('div', 'tool-label', '参数'));
    body.appendChild(el('pre', '', escapeHtml(truncate(args, 6000))));
  }
  if (result !== undefined) {
    const text = truncate(blocksText(result.blocks), 20_000);
    body.appendChild(el('div', 'tool-label', result.isError === true ? '错误' : '结果'));
    body.appendChild(el('pre', '', escapeHtml(text.length > 0 ? text : '（无文本输出）')));
  }
  node.appendChild(body);

  // 折叠状态按 callId 记住，SSE 重绘时不会把用户展开的卡片收回去。
  const id = typeof call.id === 'string' ? call.id : '';
  const openTools = state.current?.openTools;
  if (id.length > 0 && openTools?.has(id) === true) node.open = true;
  node.addEventListener('toggle', () => {
    if (id.length === 0 || state.current?.openTools === undefined) return;
    if (node.open) state.current.openTools.add(id);
    else state.current.openTools.delete(id);
  });
  return node;
}

function renderTransient() {
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
    const details = reasoningNode(transient.reasoning);
    details.open = true;
    bubble.appendChild(details);
  }
  for (const tool of transient.tools.values()) {
    bubble.appendChild(toolNode({ id: tool.id, name: tool.name || 'tool', arguments: tool.args }, undefined));
  }
  if (transient.text.length > 0) {
    const md = el('div', 'md', renderMarkdown(transient.text));
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
    renderMessages();
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
  if (document.visibilityState === 'visible' && state.view === 'list') {
    void refreshSessionsQuietly();
  }
});

if (token.length === 0) {
  showUnlock();
} else {
  route();
}

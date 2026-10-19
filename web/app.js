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
  dot: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="4"/></svg>',
};

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
      <button class="iconbtn${state.showArchived ? ' active' : ''}" id="archived-toggle" title="${state.showArchived ? '隐藏已归档会话' : '显示已归档会话'}" aria-label="已归档">${ICONS.archive}</button>
      <button class="iconbtn" id="refresh" title="刷新">${ICONS.refresh}</button>
    </header>
    <div class="list-scroll" id="list-scroll">
      <div class="search">${ICONS.search}<input id="search" placeholder="搜索会话、工作区或目录" autocomplete="off"></div>
      <div id="session-list"></div>
    </div>`;
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
      <span class="status-dot busy" id="chat-status" title="连接中"></span>
      <button class="iconbtn" id="chat-refresh" title="重新连接">${ICONS.refresh}</button>
    </header>
    <div class="chat-scroll" id="chat-scroll">
      <div class="msg-list" id="msg-list">
        <div class="boot" style="height:180px"><div class="boot-logo"></div><div class="boot-text">正在打开会话…</div></div>
      </div>
    </div>
    <div class="composer">
      <div class="composer-box">
        <textarea id="composer" rows="1" placeholder="发消息给 DSH…"></textarea>
        <button class="stop" id="stop" title="停止" style="display:none">${ICONS.stop}</button>
        <button class="send" id="send" title="发送" disabled>${ICONS.send}</button>
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
  document.querySelector('#chat-scroll').addEventListener('scroll', () => {
    const scroll = document.querySelector('#chat-scroll');
    if (state.current !== undefined) {
      state.current.nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 140;
    }
  });
  autosize(textarea);
  updateSendState();
}

function autosize(textarea) {
  if (textarea === null) return;
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, 132)}px`;
}

function updateSendState() {
  const textarea = document.querySelector('#composer');
  const send = document.querySelector('#send');
  const stop = document.querySelector('#stop');
  if (textarea === null || send === null) return;
  const hasText = textarea.value.trim().length > 0;
  send.disabled = !hasText;
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
      const pendingIndex = current.messages.findIndex((message) => message.pending === true && blocksText(message.blocks) === text);
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
    else if (block.type === 'image') html += attachmentImage(message.sessionId ?? state.current?.id, block);
    else if (block.type === 'file') html += `<div class="pill">📎 ${escapeHtml(block.attachment?.name ?? '文件')}</div>`;
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
  if (text.length === 0) return;

  textarea.value = '';
  autosize(textarea);
  updateSendState();

  const pending = {
    kind: 'user',
    pending: true,
    time: Date.now(),
    seq: Number.MAX_SAFE_INTEGER,
    blocks: [{ type: 'text', text }],
  };
  current.messages.push(pending);
  current.nearBottom = true;
  renderMessages();
  scrollToBottom(true);

  try {
    await api(`/api/sessions/${encodeURIComponent(current.id)}/prompt`, {
      method: 'POST',
      body: JSON.stringify({ text, mode: 'queue' }),
    });
  } catch (error) {
    const index = current.messages.indexOf(pending);
    if (index >= 0) current.messages.splice(index, 1);
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

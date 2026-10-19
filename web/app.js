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
  dot: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="4"/></svg>',
};

/* -------------------------------------------------------------------------- */
/* Markdown（先转义，再做最小语法）                                             */
/* -------------------------------------------------------------------------- */

function renderMarkdown(source) {
  const text = String(source ?? '');
  if (text.trim().length === 0) return '';
  const codeBlocks = [];
  let working = text.replace(/```([^\n`]*)\n([\s\S]*?)```/gu, (_match, lang, code) => {
    codeBlocks.push({ lang: String(lang).trim(), code });
    return `\u0000${codeBlocks.length - 1}\u0000`;
  });

  working = escapeHtml(working);
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

  for (const line of lines) {
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
      <button class="iconbtn" id="refresh" title="刷新">${ICONS.refresh}</button>
    </header>
    <div class="list-scroll" id="list-scroll">
      <div class="search">${ICONS.search}<input id="search" placeholder="搜索会话标题或目录" autocomplete="off"></div>
      <div id="session-list"></div>
    </div>
    <button class="fab" id="new-session" title="新建会话">${ICONS.plus}</button>`;
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
    state.sessions = Array.isArray(payload.items) ? payload.items : [];
    state.connected = true;
    renderShell();
    document.querySelector('#refresh')?.addEventListener('click', () => loadSessions({ skeleton: false }));
    const search = document.querySelector('#search');
    search.value = state.filter;
    search.addEventListener('input', () => {
      state.filter = search.value.trim();
      renderSessionList();
    });
    document.querySelector('#new-session')?.addEventListener('click', openNewSession);
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

async function refreshSessionsQuietly() {
  try {
    const payload = await api('/api/sessions');
    state.sessions = Array.isArray(payload.items) ? payload.items : [];
    state.connected = true;
    if (state.view === 'list') {
      renderSessionList();
      const sub = document.querySelector('#list-sub');
      if (sub !== null) sub.textContent = `本机 DSH · ${state.sessions.length} 个会话`;
    }
  } catch {
    state.connected = false;
  }
}

function renderSessionList() {
  const container = document.querySelector('#session-list');
  if (container === null) return;
  const sub = document.querySelector('#list-sub');
  if (sub !== null) sub.textContent = `本机 DSH · ${state.sessions.length} 个会话`;

  const filter = state.filter.toLowerCase();
  const items = state.sessions.filter((item) => {
    if (filter.length === 0) return true;
    return `${item.title ?? ''} ${item.cwd ?? ''}`.toLowerCase().includes(filter);
  });

  if (items.length === 0) {
    container.innerHTML = `<div class="empty"><div class="big">${state.sessions.length === 0 ? '🫧' : '🔍'}</div><p>${state.sessions.length === 0 ? '还没有会话，点右下角新建一个。' : '没有匹配的会话。'}</p></div>`;
    return;
  }

  let html = '';
  let lastGroup = '';
  for (const item of items) {
    const group = dayLabel(item.updatedAt);
    if (group !== lastGroup) {
      html += `<div class="group-label">${group}</div>`;
      lastGroup = group;
    }
    const pills = [
      item.running === true ? '<span class="pill run">运行中</span>' : '',
      item.origin === 'subagent' ? '<span class="pill sub">子代理</span>' : '',
    ].filter(Boolean).join('');
    html += `
      <button class="session${item.running === true ? ' running' : ''}" data-id="${escapeHtml(item.id)}">
        <span class="session-icon">${ICONS.chat}</span>
        <span class="session-main">
          <span class="session-title"><span>${escapeHtml(item.title ?? '会话')}</span>${pills}</span>
          <span class="session-meta"><span class="cwd">${escapeHtml(item.cwd || '未绑定目录')}</span></span>
        </span>
        <span class="session-time">${escapeHtml(relativeTime(item.updatedAt))}</span>
      </button>`;
  }
  container.innerHTML = html;
  for (const button of container.querySelectorAll('.session')) {
    button.addEventListener('click', () => openSession(button.dataset.id));
  }
}

/* -------------------------------------------------------------------------- */
/* 新建会话                                                                    */
/* -------------------------------------------------------------------------- */

function openNewSession() {
  const lastCwd = state.sessions.find((item) => typeof item.cwd === 'string' && item.cwd.length > 0)?.cwd ?? '';
  const mask = el('div', 'modal-mask');
  const modal = el('div', 'modal');
  modal.innerHTML = `
    <h3>新建会话</h3>
    <p>留空则使用 DSH 默认工作目录；也可以填一个绝对路径。</p>
    <input id="new-cwd" placeholder="例如 D:\\projects\\demo" value="${escapeHtml(lastCwd)}">
    <div class="modal-actions">
      <button class="btn" id="new-cancel">取消</button>
      <button class="btn primary" id="new-create">创建</button>
    </div>`;
  mask.appendChild(modal);
  document.body.appendChild(mask);
  const input = modal.querySelector('#new-cwd');
  const close = () => mask.remove();
  mask.addEventListener('click', (event) => {
    if (event.target === mask) close();
  });
  modal.querySelector('#new-cancel').addEventListener('click', close);
  const create = async () => {
    const button = modal.querySelector('#new-create');
    button.disabled = true;
    button.textContent = '创建中…';
    try {
      const payload = await api('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({ cwd: input.value.trim() }),
      });
      close();
      openSession(payload.sessionId);
    } catch (error) {
      button.disabled = false;
      button.textContent = '创建';
      toast(error.message ?? String(error));
    }
  };
  modal.querySelector('#new-create').addEventListener('click', create);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') create();
  });
  requestAnimationFrame(() => input.focus());
}

/* -------------------------------------------------------------------------- */
/* 聊天                                                                        */
/* -------------------------------------------------------------------------- */

function closeChat() {
  const current = state.current;
  state.current = undefined;
  state.pendingTexts = [];
  if (current?.source !== undefined) {
    current.source.close();
    current.source = undefined;
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
    seen: new Set(),
    minSeq: undefined,
    transient: undefined,
    running: false,
    hasMore: false,
    ready: false,
    nearBottom: true,
    source: undefined,
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
/* SSE                                                                         */
/* -------------------------------------------------------------------------- */

function closeChatSource() {
  const current = state.current;
  if (current?.source !== undefined) {
    current.source.close();
    current.source = undefined;
  }
}

function connectStream(id) {
  const current = state.current;
  if (current === undefined || current.id !== id) return;
  closeChatSource();
  const source = new EventSource(`/api/sessions/${encodeURIComponent(id)}/follow?token=${encodeURIComponent(token)}`);
  current.source = source;

  source.addEventListener('hello', (event) => {
    if (state.current !== current) return;
    try {
      const meta = JSON.parse(event.data);
      current.meta = { ...current.meta, ...meta, title: meta.title || current.meta.title };
      current.running = meta.running === true;
      state.connected = true;
      updateChatHeader();
    } catch {
      /* ignore */
    }
  });

  source.addEventListener('frame', (event) => {
    if (state.current !== current) return;
    let frame;
    try {
      frame = JSON.parse(event.data);
    } catch {
      return;
    }
    handleFrame(frame);
  });

  source.addEventListener('failed', (event) => {
    if (state.current !== current) return;
    try {
      toast(JSON.parse(event.data).error ?? '会话流中断');
    } catch {
      toast('会话流中断');
    }
  });

  source.onopen = () => {
    if (state.current !== current) return;
    state.connected = true;
    updateChatHeader();
  };
  source.onerror = () => {
    if (state.current !== current) return;
    state.connected = false;
    updateChatHeader();
    // 令牌被轮换时 EventSource 会无限重连；探一次状态以触发解锁页。
    void api('/api/status').catch(() => {});
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
    fragment.appendChild(el('div', 'empty', '<div class="big">🫧</div><p>这个会话还没有消息。发第一条吧。</p>'));
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

function toolNode(call, result, time) {
  const node = el('div', 'tool');
  const head = el('div', 'tool-head');
  head.appendChild(el('span', 'tool-icon', ICONS.tool));
  const name = el('span', 'tool-name');
  name.textContent = call.name || 'tool';
  head.appendChild(name);
  const stateNode = el('span', `tool-state ${result?.isError === true ? 'err' : result !== undefined ? 'ok' : 'run'}`);
  stateNode.textContent = result?.isError === true ? '失败' : result !== undefined ? '完成' : '运行中';
  head.appendChild(stateNode);
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

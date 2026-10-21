(() => {
  const KEY = '__dshPocketMobileShell';
  if (window[KEY]) return;
  window[KEY] = true;

  const narrow = window.matchMedia('(max-width: 768px)');
  let backdrop;

  const frame = () => document.querySelector('[class*="_frame"]');
  const closeButton = () => [...document.querySelectorAll('button')]
    .find((button) => /收起侧边栏|关闭侧边栏/.test(button.getAttribute('aria-label') || ''));

  const ensureBackdrop = () => {
    if (backdrop === undefined) {
      backdrop = document.createElement('div');
      backdrop.className = 'dsh-pocket-backdrop';
      backdrop.setAttribute('aria-hidden', 'true');
      backdrop.addEventListener('click', () => closeButton()?.click());
    }
    return backdrop;
  };

  const sync = () => {
    const current = frame();
    if (current === null) {
      backdrop?.remove();
      return;
    }
    const open = current.getAttribute('data-sidebar-collapsed') !== 'true';
    if (narrow.matches && open) {
      if (!ensureBackdrop().isConnected) document.body.appendChild(backdrop);
    } else {
      backdrop?.remove();
    }
  };

  /* ---------------------------------------------------------------------- */
  /* 手机端目录选择器：桌面端的原生目录对话框不会出现在手机上                  */
  /* ---------------------------------------------------------------------- */

  let pickerMask;
  let pickerKeyHandler;

  const closeWorkspacePicker = () => {
    pickerMask?.remove();
    pickerMask = undefined;
    if (pickerKeyHandler !== undefined) {
      document.removeEventListener('keydown', pickerKeyHandler);
      pickerKeyHandler = undefined;
    }
  };

  const openWorkspacePicker = () => {
    if (pickerMask !== undefined) return;

    const mask = document.createElement('div');
    mask.className = 'dsh-pocket-modal-mask';
    mask.innerHTML = `
      <div class="dsh-pocket-modal" role="dialog" aria-modal="true" aria-label="添加工作区">
        <h3>添加工作区</h3>
        <p>选择一个已存在的电脑目录；点目录进入，也可以直接输入路径。</p>
        <div class="dsh-pocket-path-row">
          <button type="button" class="dsh-pocket-up" title="上级目录" aria-label="上级目录">↑</button>
          <input class="dsh-pocket-input" spellcheck="false" autocomplete="off" autocapitalize="off" aria-label="目录路径">
        </div>
        <div class="dsh-pocket-dir-list" role="listbox" aria-label="子目录"></div>
        <div class="dsh-pocket-error" hidden></div>
        <div class="dsh-pocket-actions">
          <button type="button" class="dsh-pocket-cancel">取消</button>
          <button type="button" class="dsh-pocket-add primary">添加此目录</button>
        </div>
      </div>`;
    document.body.appendChild(mask);
    pickerMask = mask;

    const input = mask.querySelector('.dsh-pocket-input');
    const list = mask.querySelector('.dsh-pocket-dir-list');
    const error = mask.querySelector('.dsh-pocket-error');
    const up = mask.querySelector('.dsh-pocket-up');
    const add = mask.querySelector('.dsh-pocket-add');
    const cancel = mask.querySelector('.dsh-pocket-cancel');

    const showError = (message) => {
      error.textContent = message;
      error.hidden = false;
    };
    const clearError = () => {
      error.hidden = true;
      error.textContent = '';
    };

    const load = async (path) => {
      clearError();
      list.textContent = '';
      const loading = document.createElement('div');
      loading.className = 'dsh-pocket-dir-empty';
      loading.textContent = '正在读取…';
      list.appendChild(loading);
      try {
        const response = await fetch(`/__pocket/fs?path=${encodeURIComponent(path ?? '')}`, {
          headers: { Accept: 'application/json' },
        });
        const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
        if (payload.ok !== true) throw new Error(payload.error ?? `HTTP ${response.status}`);
        input.value = payload.path;
        up.disabled = payload.parent === null;
        up.dataset.path = payload.parent ?? '';
        list.textContent = '';
        if (payload.entries.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'dsh-pocket-dir-empty';
          empty.textContent = '这个目录下没有子目录';
          list.appendChild(empty);
        }
        for (const entry of payload.entries) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'dsh-pocket-dir';
          button.setAttribute('role', 'option');
          button.textContent = entry.name;
          button.addEventListener('click', () => void load(entry.path));
          list.appendChild(button);
        }
      } catch (failure) {
        input.value = path ?? '';
        list.textContent = '';
        showError(String(failure?.message ?? failure));
      }
    };

    up.addEventListener('click', () => void load(up.dataset.path ?? ''));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void load(input.value.trim());
      }
    });
    cancel.addEventListener('click', closeWorkspacePicker);
    mask.addEventListener('click', (event) => {
      if (event.target === mask) closeWorkspacePicker();
    });
    add.addEventListener('click', async () => {
      clearError();
      add.disabled = true;
      const previous = add.textContent;
      add.textContent = '添加中…';
      try {
        const response = await fetch('/__pocket/workspace', {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: input.value.trim() }),
        });
        const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
        if (payload.ok !== true) throw new Error(payload.error ?? `HTTP ${response.status}`);
        closeWorkspacePicker();
        window.location.reload();
      } catch (failure) {
        showError(String(failure?.message ?? failure));
        add.disabled = false;
        add.textContent = previous;
      }
    });

    void load('');

    pickerKeyHandler = (event) => {
      if (event.key === 'Escape') closeWorkspacePicker();
    };
    document.addEventListener('keydown', pickerKeyHandler);
    setTimeout(() => input.focus(), 30);
  };

  /**
   * 手机端「下载到手机」。
   *
   * 桌面 GUI 自己的文档预览只负责渲染，没有浏览器下载路由；这里用 Pocket
   * 的 `/__pocket/download`（会话 cwd + 相对/绝对路径）把原始文件流给手机。
   * 轻量页也走同一套下载语义，只是入口在自己的文件树里。
   */

  const DOWNLOAD_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v10"/><path d="m7.5 10 4.5 4.5L16.5 10"/><path d="M5 19.5h14"/></svg>';

  let toastTimer;
  const showDownloadToast = (message, ok = true) => {
    let node = document.querySelector('.dsh-pocket-download-toast');
    if (node === null) {
      node = document.createElement('div');
      node.className = 'dsh-pocket-download-toast';
      node.setAttribute('role', 'status');
      document.body.appendChild(node);
    }
    node.textContent = message;
    node.classList.toggle('error', !ok);
    node.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove('show'), 3200);
  };

  const downloadUrl = (sessionId, path) => `/__pocket/download?session=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`;

  const saveToPhone = (sessionId, path, name) => {
    const label = name || '文件';
    const url = downloadUrl(sessionId, path);
    // 必须同步点击 anchor：iOS Safari 会把 await 之后的下载当成非用户手势拦截。
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = label;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    showDownloadToast(`开始下载 ${label}`);
    // 下载已经开始，再补一次 HEAD 只用于把 404/403 提示出来。
    fetch(url, { method: 'HEAD', credentials: 'same-origin' })
      .then((response) => {
        if (!response.ok) showDownloadToast(`下载失败：HTTP ${response.status}`, false);
      })
      .catch(() => {
        /* 网络抖动不打断下载 */
      });
  };

  /**
   * `dsh-resource://file/session/<sessionId>/<path>` → 会话与相对路径。
   * @param {string} source
   */
  const parseSessionResource = (source) => {
    const prefix = 'dsh-resource://file/session/';
    if (!source.startsWith(prefix)) return null;
    const rest = source.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash <= 0) return null;
    let path;
    try {
      path = decodeURIComponent(rest.slice(slash + 1));
    } catch {
      path = rest.slice(slash + 1);
    }
    if (path.length === 0) return null;
    const name = path.split(/[\\/]/u).filter(Boolean).pop() ?? 'download';
    return { sessionId: decodeURIComponent(rest.slice(0, slash)), path, name };
  };

  const enhancePreviewDownload = (preview) => {
    const pathSpan = preview.querySelector('[data-textpreview-path]');
    const header = pathSpan?.parentElement;
    const target = parseSessionResource(preview.getAttribute('data-textpreview-url') ?? '');
    if (header === null || header === undefined || target === null) return;

    let button = header.querySelector('.dsh-pocket-preview-download');
    if (button === null) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'TdjKvG_tool dsh-pocket-preview-download';
      button.setAttribute('aria-label', '下载到手机');
      button.title = '下载到手机';
      button.innerHTML = DOWNLOAD_ICON;
      // 紧跟在路径后面；header 里有嵌套的按钮组，不能拿 querySelector 的结果
      // 直接当 insertBefore 的参照节点。
      header.insertBefore(button, pathSpan.nextSibling);
    }
    button.dataset.session = target.sessionId;
    button.dataset.path = target.path;
    button.dataset.name = target.name;
    if (button.dataset.bound === 'true') return;
    button.dataset.bound = 'true';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void saveToPhone(button.dataset.session, button.dataset.path, button.dataset.name);
    });
  };

  const enhanceFileRowDownloads = (root) => {
    const panel = root.closest('[data-sidebar-right-session]') ?? root.closest('[data-conversation-session]');
    const sessionId = panel?.getAttribute('data-sidebar-right-session')
      ?? panel?.getAttribute('data-conversation-session')
      ?? document.querySelector('[data-conversation-session]')?.getAttribute('data-conversation-session');
    if (sessionId === null || sessionId === undefined) return;

    for (const row of root.querySelectorAll('button[class*="row"]')) {
      // 目录行带 aria-expanded；文件行没有，且点击会打开文档预览。
      if (row.hasAttribute('aria-expanded') || row.querySelector('.dsh-pocket-row-download') !== null) continue;
      const name = (row.textContent ?? '').trim();
      if (name.length === 0 || name.includes('\n')) continue;
      const span = document.createElement('span');
      span.className = 'dsh-pocket-row-download';
      span.setAttribute('role', 'button');
      span.setAttribute('tabindex', '0');
      span.setAttribute('aria-label', `下载 ${name}`);
      span.title = '下载到手机';
      span.innerHTML = DOWNLOAD_ICON;
      const trigger = (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        const dir = root.querySelector('[data-files-path]')?.getAttribute('title') ?? root.getAttribute('data-files-root');
        if (typeof dir !== 'string' || dir.length === 0) return;
        const base = dir.replace(/[\\/]+$/u, '');
        void saveToPhone(sessionId, `${base}/${name}`, name);
      };
      span.addEventListener('click', trigger);
      span.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') trigger(event);
      });
      row.appendChild(span);
    }
  };

  let scanQueued = false;
  const scanDownloads = () => {
    scanQueued = false;
    for (const preview of document.querySelectorAll('[data-document-preview]')) enhancePreviewDownload(preview);
    for (const root of document.querySelectorAll('[data-files-root]')) enhanceFileRowDownloads(root);
  };
  const queueDownloadScan = () => {
    if (scanQueued) return;
    scanQueued = true;
    setTimeout(scanDownloads, 30);
  };
  new MutationObserver(queueDownloadScan).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-textpreview-url', 'data-files-state'],
  });
  scanDownloads();

  // A chosen session should reveal the conversation immediately; folding a
  // workspace (projectRow) or opening its menu must leave the drawer alone.
  document.addEventListener('click', (event) => {
    if (!narrow.matches) return;
    const session = event.target?.closest?.('[class*="sessionRow"]');
    const newSession = event.target?.closest?.('button[aria-label*="新建会话"], button[aria-label="新会话"]');
    if (session !== null && session !== undefined) setTimeout(() => closeButton()?.click(), 60);
    else if (newSession !== null && newSession !== undefined) setTimeout(() => closeButton()?.click(), 60);
  }, true);

  // Intercept the workspace-add action: on a phone the host would open its
  // native folder dialog on the computer. Use the Pocket picker instead.
  document.addEventListener('click', (event) => {
    if (!narrow.matches) return;
    const trigger = event.target?.closest?.('button[aria-label="添加工作区"]');
    if (trigger === null || trigger === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    openWorkspacePicker();
  }, true);

  new MutationObserver(sync).observe(document.documentElement, {
    attributes: true,
    subtree: true,
    attributeFilter: ['data-sidebar-collapsed'],
  });
  narrow.addEventListener('change', sync);
  sync();
})();

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

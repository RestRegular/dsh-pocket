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

  // A chosen session should reveal the conversation immediately.
  document.addEventListener('click', (event) => {
    if (!narrow.matches) return;
    const row = event.target?.closest?.('[role="treeitem"]');
    if (row !== null && row !== undefined) setTimeout(() => closeButton()?.click(), 60);
  }, true);

  new MutationObserver(sync).observe(document.documentElement, {
    attributes: true,
    subtree: true,
    attributeFilter: ['data-sidebar-collapsed'],
  });
  narrow.addEventListener('change', sync);
  sync();
})();

/**
 * dsh-pocket — Client half.
 *
 * 在侧栏「全局面板」里加一行 Pocket，并在中央区域渲染管理页：
 * 手机服务地址、隧道状态与启停、令牌轮换。
 *
 * 所有数据走宿主同源回环路由 `/dsh-pocket`（见 ../lib/index.js），
 * 只接受本机请求，所以这里不需要额外鉴权。
 *
 * 注册 id 必须逐字等于包名，否则 HMR 的模块图无法清理旧工厂。
 *
 * 整个文件包在 IIFE 里：client 模块会被宿主拼成同一个 <script> 批次，
 * 顶层 `const` 会与同批次其它插件（例如 dsh-skill-center 的 MODULE_ID）
 * 共享全局词法作用域；重名就是 SyntaxError，整条 web boot 会失败。
 */
(() => {
const MODULE_ID = '@restregular/dsh-pocket';

function alreadyRegistered() {
  const factories = window.__ModuleLoader__?.factories;
  return factories !== undefined && typeof factories.has === 'function' && factories.has(MODULE_ID);
}

if (!alreadyRegistered()) {
  window.__ModuleLoader__.load({
    id: MODULE_ID,
    factory: (require) => {
      const React = require('react');
      const h = React.createElement;
      const { useCallback, useEffect, useRef, useState } = React;

      const OWNER = 'dsh-pocket';
      const PANEL_ID = 'pocket';
      const API = '/dsh-pocket';

      const ZH = {
        panel: '随身访问',
        title: '随身访问',
        subtitle: '把本机 DSH 装进口袋：手机查看会话与实时输出，反向发送指令。',
        server: '手机服务',
        listening: '监听中',
        stopped: '未启动',
        port: '端口',
        bind: '绑定',
        tunnel: '外网隧道',
        tunnelOff: '未开启',
        tunnelStarting: '正在建立…',
        tunnelOnline: '已连通',
        tunnelError: '建立失败',
        provider: '通道',
        publicEntry: '公网入口',
        overview: '概览',
        serverCard: '手机服务',
        serverCardHint: '手机与电脑在同一网络时可直接使用局域网地址。',
        tunnelCard: '公网通道',
        tunnelCardHint: 'Cloudflared 开箱即用；自有服务器走 SSH 反向转发。',
        connectCard: '手机连接',
        connectHint: '扫码即可打开 Pocket；链接内含访问令牌，请勿公开分享。',
        qrPublicEmpty: '公网隧道未开启',
        qrLanEmpty: '未发现局域网地址',
        qrScan: '扫码打开',
        publicEntryHint: '选择手机从外网访问时使用的通道。',
        cloudflared: 'Cloudflared（默认）',
        cloudflaredShort: 'Cloudflared',
        cloudflaredDesc: '自动 HTTPS 域名 · 无需服务器',
        ownServer: '自有服务器',
        ownServerDesc: 'SSH 反向转发 · 自备公网 IP',
        serverAddress: '服务器 IP / 域名',
        serverAddressHint: '需已配置免密 SSH，默认使用 root 与 80 端口。',
        switchTunnel: '应用并重启',
        switching: '切换中…',
        serverRequired: '请填写服务器 IP 或域名',
        lanIp: '局域网 IP',
        lanAuto: '自动选择',
        lanAutoDesc: '优先物理网卡',
        lanVirtual: '虚拟网卡',
        lanHint: '二维码与分享链接优先使用选中的地址。',
        openPhone: '打开手机页面',
        securityCard: '安全',
        tokenHint: '等同于本机 DSH 的钥匙',
        online: '在线',
        offline: '未启动',
        sshHint: '自有服务器默认走 HTTP；令牌会明文传输，生产建议配置 HTTPS 反向代理。',
        start: '启动隧道',
        stop: '停止',
        restart: '重新建立',
        addresses: '访问地址',
        local: '本机',
        lan: '局域网',
        public: '公网',
        noLan: '未发现局域网地址',
        copy: '复制',
        copied: '已复制',
        open: '打开',
        warning: '链接里带有 128 位访问令牌，等同于本机 DSH 的钥匙，请勿转发到公开场合。',
        security: '安全',
        token: '访问令牌',
        rotate: '轮换令牌',
        rotateConfirm: '确认轮换？手机上已保存的链接会立即失效。',
        confirm: '确认',
        cancel: '取消',
        loading: '正在读取状态…',
        refresh: '刷新',
        error: '操作失败',
        hintLan: '手机和电脑在同一 Wi-Fi 时用局域网地址；外网访问用公网隧道地址。局域网打不开时，请允许 DSH / Node 通过 Windows 防火墙。',
        hintTunnel: '默认 auto：依次尝试 cloudflared、localtunnel、localhost.run；都不可用时可安装 cloudflared，或配置 custom 命令。',
        log: '隧道输出',
        qrTitle: '扫码连接',
        qrHint: '用手机相机扫描二维码，即可打开 Pocket。',
        awakeCard: '电脑常亮',
        awakeHint: '让系统不因空闲睡眠，远程连接保持可用。',
        awakeOn: '已开启',
        awakeOff: '已关闭',
        awakeEnable: '开启常亮',
        awakeDisable: '关闭常亮',
        awakeIdleHint: '开启后系统与屏幕都不会因空闲关闭，正在运行的任务不会因电脑睡眠中断。',
        awakeActiveHint: '系统与屏幕正被阻止进入空闲睡眠。',
        awakeUnsupported: '当前平台不支持保持常亮。',
        awakeNote: '开关状态会保存，DSH 重启后恢复；锁屏仍由系统安全策略/屏幕保护决定。',
        displayCard: '手机显示与截断',
        displayHint: '控制手机端长内容的显示；桌面和手机会共用这份设置。',
        displayTools: '工具输出',
        displayToolsDesc: '工具结果与调用参数',
        displayAssistant: 'Agent 回复',
        displayAssistantDesc: '助手正文内容',
        displayReasoning: '思考过程',
        displayReasoningDesc: 'reasoning 内容',
        displayLimit: '截断长度',
        displayLimitUnit: '字符',
        displaySave: '保存显示设置',
        displayRange: '截断长度需在 500–50000 字符之间',
        displayNote: '关闭某类截断后，这类内容会完整发送到手机，可能增加流量和首屏时间。',
        surfaceCard: '手机端界面',
        surfaceHint: '选择手机打开时看到的界面。',
        surfaceMobile: '轻量界面',
        surfaceMobileDesc: 'Pocket 自带手机页 · 省流量、首屏快',
        surfaceDesktop: '桌面直通',
        surfaceDesktopDesc: '桌面端同一份界面 · 插件全在',
        surfaceNote: '切换后会自动刷新本页；直通模式下手机加载的就是桌面 Web GUI。',
        surfaceUnavailable: '桌面 Web 界面没有在运行，暂时只能使用轻量界面。',
        tabOverview: '概览',
        tabSettings: '设置',
        settingsScope: '这些设置只作用于手机上打开的 Pocket 页面，桌面 DSH 窗口不受影响。',
        displayOnlyMobile: '当前是桌面直通：显示与截断只作用于轻量界面，所以这里不显示。切回「轻量界面」后可以继续调整。',
        narrowCard: '窄屏适配',
        narrowHint: '桌面界面在手机上的布局优化。',
        narrowLabel: '侧栏改成抽屉',
        narrowDesc: '展开侧栏时覆盖内容并加遮罩，设置页的左侧导航改成顶部标签。',
        narrowOn: '已开启',
        narrowOff: '已关闭',
        narrowNote: '修改后刷新手机上的页面生效；关闭后恢复桌面原始布局。',
        settingsFootnote: '切换界面模式后，手机上的页面需要刷新一次。',
        surfaceSwitched: '已切换界面模式，手机上的页面刷新后生效。',
      };

      const EN = {
        panel: 'Pocket Access',
        title: 'Pocket Access',
        subtitle: 'Your DSH in your pocket: read sessions and live output on a phone, and send prompts back.',
        server: 'Mobile server',
        listening: 'Listening',
        stopped: 'Stopped',
        port: 'Port',
        bind: 'Bind',
        tunnel: 'Tunnel',
        tunnelOff: 'Off',
        tunnelStarting: 'Connecting…',
        tunnelOnline: 'Online',
        tunnelError: 'Failed',
        provider: 'Provider',
        publicEntry: 'Public entry',
        overview: 'Overview',
        serverCard: 'Mobile server',
        serverCardHint: 'Use a LAN URL when the phone and this computer share a network.',
        tunnelCard: 'Public channel',
        tunnelCardHint: 'Cloudflared works out of the box; the own-server relay uses SSH.',
        connectCard: 'Phone access',
        connectHint: 'Scan to open Pocket. The URL carries an access token; do not share it publicly.',
        qrPublicEmpty: 'Public tunnel is offline',
        qrLanEmpty: 'No LAN address found',
        qrScan: 'Scan to open',
        publicEntryHint: 'Choose the route used to reach this DSH from outside the LAN.',
        cloudflared: 'Cloudflared (default)',
        cloudflaredShort: 'Cloudflared',
        cloudflaredDesc: 'Automatic HTTPS host · no server needed',
        ownServer: 'Own server',
        ownServerDesc: 'SSH reverse relay · your public IP',
        serverAddress: 'Server IP / hostname',
        serverAddressHint: 'Requires passwordless SSH; root and port 80 are used by default.',
        switchTunnel: 'Apply and restart',
        switching: 'Switching…',
        serverRequired: 'Enter a server IP or hostname',
        lanIp: 'LAN IP',
        lanAuto: 'Auto',
        lanAutoDesc: 'Prefer a physical adapter',
        lanVirtual: 'virtual adapter',
        lanHint: 'The QR code and shared links prefer the selected address.',
        openPhone: 'Open phone page',
        securityCard: 'Security',
        tokenHint: 'Equivalent to the key to this DSH',
        online: 'Online',
        offline: 'Stopped',
        sshHint: 'The own-server relay uses plain HTTP by default; the token crosses the network in clear text. Use HTTPS behind a reverse proxy in production.',
        start: 'Start tunnel',
        stop: 'Stop',
        restart: 'Restart',
        addresses: 'Access URLs',
        local: 'Local',
        lan: 'LAN',
        public: 'Public',
        noLan: 'No LAN address found',
        copy: 'Copy',
        copied: 'Copied',
        open: 'Open',
        warning: 'These URLs carry a 128-bit access token. Treat them like the key to this DSH; do not post them publicly.',
        security: 'Security',
        token: 'Access token',
        rotate: 'Rotate token',
        rotateConfirm: 'Rotate the token? Links already saved on a phone stop working immediately.',
        confirm: 'Rotate',
        cancel: 'Cancel',
        loading: 'Reading status…',
        refresh: 'Refresh',
        error: 'Action failed',
        hintLan: 'On the same Wi-Fi use the LAN URL; from anywhere use the public tunnel URL. If the LAN URL fails, allow DSH or Node through the Windows firewall.',
        hintTunnel: 'auto tries cloudflared, then localtunnel, then localhost.run. Install cloudflared, or configure a custom command, if none is available.',
        log: 'Tunnel output',
        qrTitle: 'Scan to connect',
        qrHint: 'Scan this code with a phone camera to open Pocket.',
        awakeCard: 'Keep awake',
        awakeHint: 'Stop the system from idle-sleeping so remote access stays available.',
        awakeOn: 'Active',
        awakeOff: 'Off',
        awakeEnable: 'Keep awake',
        awakeDisable: 'Turn off',
        awakeIdleHint: 'While on, the system and display stay out of idle sleep, so running tasks are not interrupted.',
        awakeActiveHint: 'Idle sleep of the system and display is being blocked.',
        awakeUnsupported: 'Keep-awake is not supported on this platform.',
        awakeNote: 'The choice is saved and restored when DSH restarts. Lock screen policy is still controlled by the OS.',
        displayCard: 'Phone display & truncation',
        displayHint: 'Control how long content appears on the phone. Desktop and phone share these settings.',
        displayTools: 'Tool output',
        displayToolsDesc: 'Tool results and call arguments',
        displayAssistant: 'Agent reply',
        displayAssistantDesc: 'Assistant text content',
        displayReasoning: 'Thinking',
        displayReasoningDesc: 'Reasoning content',
        displayLimit: 'Truncation length',
        displayLimitUnit: 'chars',
        displaySave: 'Save display settings',
        displayRange: 'Truncation length must be between 500 and 50000 characters',
        displayNote: 'When a category is not truncated, its content is sent to the phone in full and may increase traffic and first-load time.',
        surfaceCard: 'Phone surface',
        surfaceHint: 'Choose what the phone opens.',
        surfaceMobile: 'Lightweight',
        surfaceMobileDesc: 'Pocket’s own phone page · light and fast',
        surfaceDesktop: 'Desktop passthrough',
        surfaceDesktopDesc: 'The same desktop UI · every plugin included',
        surfaceNote: 'This page refreshes after switching; passthrough serves the desktop Web GUI itself.',
        surfaceUnavailable: 'The desktop Web GUI is not running, so only the lightweight page is available.',
        tabOverview: 'Overview',
        tabSettings: 'Settings',
        settingsScope: 'These settings only affect the Pocket page on your phone, not the desktop DSH window.',
        displayOnlyMobile: 'Desktop passthrough is active. Display and truncation only apply to the lightweight page, so they are hidden here.',
        narrowCard: 'Phone layout',
        narrowHint: 'Layout tuning for the desktop UI on a phone.',
        narrowLabel: 'Sidebar as a drawer',
        narrowDesc: 'Overlay the content with a dimmed backdrop and turn the settings sidebar into top tabs.',
        narrowOn: 'On',
        narrowOff: 'Off',
        narrowNote: 'Refresh the page on your phone to apply; turn off to restore the original desktop layout.',
        settingsFootnote: 'Refresh the page on your phone after switching surfaces.',
        surfaceSwitched: 'Surface changed; refresh the page on your phone to apply.',
      };

      const LANG = (navigator.language || 'zh').toLowerCase().startsWith('zh') ? ZH : EN;

      const CSS = `
.dsh-pk{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
.dsh-pk-head{flex:none;display:flex;flex-direction:column;align-items:stretch;gap:0;padding:16px 22px 13px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.dsh-pk-head-main{min-width:0;flex:1}
.dsh-pk-title{font-size:16px;font-weight:650;margin:0}
.dsh-pk-sub{color:var(--dsw-alias-label-tertiary);font-size:12px;margin-top:3px}
.dsh-pk-spacer{flex:1}
.dsh-pk-body{flex:1;min-height:0;overflow:auto;padding:18px 22px 36px;display:flex;flex-direction:column;gap:16px;max-width:900px;width:100%;margin:0 auto}
.dsh-pk-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}
.dsh-pk-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:var(--dsw-radius-lg,12px);padding:14px 15px;min-width:0}
.dsh-pk-card-top{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.dsh-pk-card-title{font-weight:600;font-size:13px;flex:1;min-width:0}
.dsh-pk-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-caption);flex:none}
.dsh-pk-dot.on{background:var(--dsw-alias-state-success-primary,#46d39a);box-shadow:0 0 0 3px rgba(70,211,154,.13)}
.dsh-pk-dot.warn{background:var(--dsw-alias-state-warn-primary,#f5b84b);box-shadow:0 0 0 3px rgba(245,184,75,.13)}
.dsh-pk-dot.err{background:var(--dsw-alias-state-error-primary,#ff6b6b)}
.dsh-pk-dot.busy{animation:dsh-pk-blink 1s ease-in-out infinite}
@keyframes dsh-pk-blink{50%{opacity:.3}}
.dsh-pk-kv{display:grid;grid-template-columns:72px 1fr;gap:4px 10px;margin:0;font-size:12px}
.dsh-pk-kv dt{color:var(--dsw-alias-label-tertiary)}
.dsh-pk-kv dd{margin:0;word-break:break-all;color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-mono,ui-monospace,Consolas,monospace)}
.dsh-pk-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:6px 11px;border-radius:var(--dsw-radius-md,8px);border:1px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-button-elevated-fill);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.dsh-pk-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-pk-btn.primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted);filter:none;box-shadow:inset 0 0 0 2px var(--dsw-alias-border-l3)}
.dsh-pk-btn.primary:active:not(:disabled){background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted);box-shadow:inset 0 0 0 2px var(--dsw-alias-border-l3)}
.dsh-pk-btn:disabled{opacity:.45;cursor:default}
.dsh-pk-btn.primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-inverted)}
.dsh-pk-btn.danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dsh-pk-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.dsh-pk-field{display:flex;flex-direction:column;gap:5px;margin-top:12px}
.dsh-pk-label{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dsh-pk-select,.dsh-pk-input{width:100%;padding:7px 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;outline:none}
.dsh-pk-select:focus,.dsh-pk-input:focus{border-color:var(--dsw-alias-border-l3)}
.dsh-pk-input::placeholder{color:var(--dsw-alias-label-caption)}
.dsh-pk-lanpick{display:flex;align-items:center;gap:8px;margin:0 0 10px;min-width:0}
.dsh-pk-lanpick-label{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dsh-pk-lanpick .dsh-pk-select{width:auto;flex:1;min-width:0}
.dsh-pk-url{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:10px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);margin-bottom:8px;min-width:0}
.dsh-pk-url-label{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);width:40px}
.dsh-pk-url-text{flex:1;min-width:0;font-family:var(--dsw-font-mono,ui-monospace,Consolas,monospace);font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary)}
.dsh-pk-empty{color:var(--dsw-alias-label-caption);font-size:12px;padding:4px 0}
.dsh-pk-note{border-radius:10px;padding:10px 12px;font-size:12px;line-height:1.6;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-tertiary)}
.dsh-pk-err{color:var(--dsw-alias-state-error-primary);word-break:break-word;font-size:12px;margin-top:6px}
.dsh-pk-log{margin:8px 0 0;padding:9px 11px;border-radius:9px;background:var(--dsw-alias-markdown-code-block,#0a0d13);font-family:var(--dsw-font-mono,ui-monospace,Consolas,monospace);font-size:11px;line-height:1.55;white-space:pre-wrap;word-break:break-word;max-height:150px;overflow:auto;color:var(--dsw-alias-label-tertiary)}
.dsh-pk-details{margin-top:10px}
.dsh-pk-details summary{cursor:pointer;font-size:11px;color:var(--dsw-alias-label-caption);list-style:none;user-select:none}
.dsh-pk-details summary::-webkit-details-marker{display:none}
.dsh-pk-details summary::before{content:'▸ ';}
.dsh-pk-details[open] summary::before{content:'▾ ';}
.dsh-pk-qr{display:flex;gap:16px;align-items:center;flex-wrap:wrap}
.dsh-pk-qr img{width:168px;height:168px;border-radius:12px;background:#fff;padding:6px;border:1px solid var(--dsw-alias-border-l2);flex:none}
.dsh-pk-qr-side{flex:1;min-width:180px;min-height:0}
.dsh-pk-qr-title{font-weight:600;font-size:13px;margin-bottom:5px;word-break:break-all}
.dsh-pk-qr-hint{font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.6;word-break:break-all}
.dsh-pk-toast{position:fixed;left:50%;bottom:32px;transform:translateX(-50%);padding:8px 15px;border-radius:10px;background:var(--dsw-alias-bg-layer-4,#1a2230);border:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary);font-size:12px;z-index:80;box-shadow:0 10px 30px rgba(0,0,0,.35)}
.dsh-pk-center{flex:1;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary)}
.dsh-pk-head-actions{display:flex;align-items:center;gap:8px;flex:none}
.dsh-pk-eyebrow{font-size:10px;letter-spacing:.14em;color:var(--dsw-alias-label-caption);font-weight:650;margin-bottom:3px}
.dsh-pk-body{padding-top:16px;gap:14px;max-width:940px}
.dsh-pk-pill{display:inline-flex;align-items:center;gap:6px;padding:4px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.3;white-space:nowrap;flex:none}
.dsh-pk-pill-dot{width:5px;height:5px;border-radius:50%;background:currentColor;flex:none}
.dsh-pk-pill.on{color:var(--dsw-alias-state-success-primary,#46d39a);border-color:var(--dsw-alias-state-success-primary,#46d39a)}
.dsh-pk-pill.warn{color:var(--dsw-alias-state-warn-primary,#f5b84b);border-color:var(--dsw-alias-state-warn-primary,#f5b84b)}
.dsh-pk-pill.err{color:var(--dsw-alias-state-error-primary,#ff6b6b);border-color:var(--dsw-alias-state-error-primary,#ff6b6b)}
.dsh-pk-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.dsh-pk-stat{display:flex;flex-direction:column;gap:2px;min-width:0;padding:11px 13px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-1)}
.dsh-pk-stat-label{font-size:10.5px;letter-spacing:.03em;color:var(--dsw-alias-label-tertiary)}
.dsh-pk-stat-value{font-size:13px;font-weight:650;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-pk-stat-sub{font-size:10.5px;color:var(--dsw-alias-label-caption);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--dsw-font-mono,ui-monospace,Consolas,monospace)}
.dsh-pk-grid{align-items:stretch}
.dsh-pk-card{display:flex;flex-direction:column;padding:16px}
.dsh-pk-card-top{align-items:flex-start;margin-bottom:4px;gap:10px}
.dsh-pk-card-icon{width:30px;height:30px;border-radius:9px;display:inline-flex;align-items:center;justify-content:center;flex:none;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.dsh-pk-card-heading{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.dsh-pk-card-sub{font-size:11px;line-height:1.45;color:var(--dsw-alias-label-caption);font-weight:400}
.dsh-pk-card-top .dsh-pk-pill{margin-left:auto;margin-top:2px}
.dsh-pk-field-label{font-size:11px;color:var(--dsw-alias-label-tertiary);font-weight:550}
.dsh-pk-hint{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-caption)}
.dsh-pk-picker{position:relative;min-width:0}
.dsh-pk-picker-btn{width:100%;display:flex;align-items:center;gap:9px;padding:9px 11px;border-radius:10px;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer;transition:border-color .12s ease,background .12s ease}
.dsh-pk-picker-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l4);background:var(--dsw-alias-interactive-bg-hover)}
.dsh-pk-picker-btn.open{border-color:var(--dsw-alias-button-primary-fill)}
.dsh-pk-picker-btn:disabled{opacity:.5;cursor:default}
.dsh-pk-picker-copy{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1}
.dsh-pk-picker-value{font-size:12.5px;font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-pk-picker-desc{font-size:10.5px;color:var(--dsw-alias-label-caption);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-pk-picker-chevron{flex:none;color:var(--dsw-alias-label-caption);transition:transform .15s ease}
.dsh-pk-picker-btn.open .dsh-pk-picker-chevron{transform:rotate(180deg)}
.dsh-pk-menu{position:absolute;left:0;right:0;top:calc(100% + 6px);z-index:30;padding:5px;border-radius:12px;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2));box-shadow:0 18px 44px rgba(0,0,0,.28);max-height:250px;overflow:auto}
.dsh-pk-menu-item{width:100%;display:flex;align-items:center;gap:8px;padding:8px 9px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer}
.dsh-pk-menu-item:hover,.dsh-pk-menu-item:focus-visible{background:var(--dsw-alias-interactive-bg-hover);outline:none}
.dsh-pk-menu-item.selected{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-pk-menu-copy{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1}
.dsh-pk-menu-label{font-size:12px;font-weight:550}
.dsh-pk-menu-desc{font-size:10.5px;color:var(--dsw-alias-label-caption)}
.dsh-pk-menu-check{flex:none;color:var(--dsw-alias-button-primary-fill)}
.dsh-pk-input-shell{display:flex;align-items:center;gap:8px;padding:0 10px;border-radius:10px;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-caption)}
.dsh-pk-input-shell:focus-within{border-color:var(--dsw-alias-button-primary-fill)}
.dsh-pk-input-shell .dsh-pk-input{flex:1;min-width:0;padding:9px 0;border:0;background:transparent}
.dsh-pk-card-footer{margin-top:auto;padding-top:14px}
.dsh-pk-textlink{font-size:12px;color:var(--dsw-alias-button-primary-fill);text-decoration:none;font-weight:550}
.dsh-pk-textlink:hover{text-decoration:underline}
.dsh-pk-btn.block{width:100%;margin-top:10px;padding:9px 12px}
.dsh-pk-url{padding:7px 9px 7px 11px;margin-bottom:7px;background:var(--dsw-alias-bg-layer-1)}
.dsh-pk-url-label{width:44px}
.dsh-pk-url-actions{display:flex;align-items:center;gap:2px;flex:none}
.dsh-pk-url-action{padding:4px 6px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;text-decoration:none;cursor:pointer}
.dsh-pk-url-action:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dsh-pk-connect-card{margin-top:0}
.dsh-pk-connect{display:flex;align-items:center;gap:18px;flex-wrap:wrap;margin-top:12px}
.dsh-pk-qr-wrap{flex:none;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;padding:9px 9px 7px;border-radius:14px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.dsh-pk-qr-wrap img{width:160px;height:160px;display:block;border-radius:8px;background:#fff;padding:5px}
.dsh-pk-qr-caption{font-size:10.5px;color:var(--dsw-alias-label-caption)}
.dsh-pk-qr-wrap.empty{width:160px;min-height:160px;border-style:dashed;color:var(--dsw-alias-label-caption);font-size:11px;text-align:center;line-height:1.5}
.dsh-pk-qr-group{display:flex;gap:12px;flex:none;flex-wrap:wrap}
.dsh-pk-qr-card{width:178px;flex:none;display:flex;flex-direction:column;align-items:center;gap:7px;padding:9px 9px 8px;border-radius:14px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.dsh-pk-qr-card-head{width:100%;display:flex;align-items:center;justify-content:space-between;gap:6px}
.dsh-pk-qr-card-label{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.dsh-pk-qr-badge{font-size:9.5px;color:var(--dsw-alias-label-caption);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:1px 6px;line-height:1.5}
.dsh-pk-qr-card img{width:158px;height:158px;display:block;border-radius:8px;background:#fff;padding:5px}
.dsh-pk-qr-empty{width:158px;height:158px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;border:1px dashed var(--dsw-alias-border-l3);border-radius:8px;color:var(--dsw-alias-label-caption);font-size:10.5px;text-align:center;line-height:1.45;padding:8px}
.dsh-pk-qr-host{max-width:100%;font-family:var(--dsw-font-mono,ui-monospace,Consolas,monospace);font-size:10px;color:var(--dsw-alias-label-caption);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-pk-links{flex:1;min-width:220px}
.dsh-pk-links .dsh-pk-note{margin-top:6px}
.dsh-pk-security{display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-2)}
.dsh-pk-security-main{display:flex;align-items:center;gap:10px;min-width:0;flex:1}
.dsh-pk-token{font-family:var(--dsw-font-mono,ui-monospace,Consolas,monospace);font-size:11px;color:var(--dsw-alias-label-tertiary);padding:2px 7px;border-radius:6px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);white-space:nowrap}
.dsh-pk-toggle-row{display:flex;align-items:center;gap:12px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1);margin-top:6px}
.dsh-pk-toggle-copy{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1}
.dsh-pk-toggle-label{font-size:12px;font-weight:550;color:var(--dsw-alias-label-primary)}
.dsh-pk-toggle-desc{font-size:10.5px;color:var(--dsw-alias-label-caption)}
.dsh-pk-switch{position:relative;flex:none;width:36px;height:20px;padding:0;border:1px solid color-mix(in srgb,var(--dsw-alias-label-caption) 24%,transparent);border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-caption) 28%,transparent);cursor:pointer;transition:background .15s ease,border-color .15s ease}
.dsh-pk-switch:hover:not(:disabled){border-color:color-mix(in srgb,var(--dsw-alias-label-caption) 42%,transparent)}
.dsh-pk-switch:focus-visible{outline:2px solid var(--dsw-alias-button-primary-fill);outline-offset:2px}
.dsh-pk-switch:disabled{opacity:.5;cursor:default}
.dsh-pk-switch.on{background:var(--dsw-alias-button-primary-fill,#3b70e8);border-color:transparent}
.dsh-pk-switch-thumb{position:absolute;top:50%;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-switch-thumb,#fff);box-shadow:0 1px 2px rgba(0,0,0,.28);transform:translateY(-50%);transition:left .15s ease,background .15s ease}
.dsh-pk-switch.on .dsh-pk-switch-thumb{left:18px}
.dsh-pk-display-limit{display:flex;align-items:center;gap:8px;margin-top:6px}
.dsh-pk-display-limit .dsh-pk-input{flex:1;min-width:0}
.dsh-pk-display-limit span{flex:none;font-size:11px;color:var(--dsw-alias-label-caption)}
.dsh-pk,.dsh-pk *{box-sizing:border-box}
.dsh-pk-head-row{display:flex;align-items:flex-start;gap:12px;width:100%}
.dsh-pk-tabs{display:flex;gap:3px;margin-top:11px;padding:3px;border-radius:10px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);align-self:flex-start}
.dsh-pk-tab{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;font-weight:550;padding:6px 16px;border-radius:8px;cursor:pointer;transition:background .15s ease,color .15s ease}
.dsh-pk-tab:hover:not(.active){color:var(--dsw-alias-label-primary)}
.dsh-pk-tab.active{background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgba(0,0,0,.1)}
.dsh-pk-settings-note{padding:10px 12px;border:1px dashed var(--dsw-alias-border-l2);border-radius:9px;color:var(--dsw-alias-label-caption);font-size:11.5px;line-height:1.6}

@media (max-width: 768px) {
  .dsh-pk-head{padding:14px 16px 10px}
  .dsh-pk-body{padding:14px 16px 28px;max-width:100%}
  .dsh-pk-head-row{gap:10px}
  .dsh-pk-tabs{width:100%;margin-top:9px}
  .dsh-pk-tab{flex:1;padding:7px 0}
  .dsh-pk-grid{grid-template-columns:minmax(0,1fr)}
  .dsh-pk-stats{grid-template-columns:repeat(2,minmax(0,1fr))}
  .dsh-pk-sub{font-size:11.5px}
  .dsh-pk-links{min-width:0}
  /* 二维码组在窄屏下不要按内容宽度撑开：改成两列等宽、图随卡片缩放 */
  .dsh-pk-connect{gap:14px}
  .dsh-pk-qr-group{flex:1 1 100%;width:100%;min-width:0;gap:10px}
  .dsh-pk-qr-card{flex:1 1 0;width:auto;min-width:0;max-width:178px}
  .dsh-pk-qr-card img,.dsh-pk-qr-empty{width:100%;max-width:158px;height:auto;aspect-ratio:1}
}

[data-platform='darwin'] .dsh-pk-head{padding-top:calc(30px + var(--dsh-frame-top-clearance,0px))}
`;

      function createOwnedStyle(css) {
        const el = document.createElement('style');
        el.setAttribute('data-plugin', OWNER);
        el.textContent = css;
        document.head.appendChild(el);
        return el;
      }

      async function call(op, body) {
        const url = new URL(API, window.location.origin);
        url.searchParams.set('op', op);
        const response = await fetch(url.toString(), body === undefined ? {
          headers: { Accept: 'application/json' },
        } : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ op, ...body }),
        });
        const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
        if (payload.ok !== true) throw new Error(payload.error ?? `HTTP ${response.status}`);
        return payload.status;
      }

      function copyText(text) {
        if (navigator.clipboard?.writeText !== undefined) return navigator.clipboard.writeText(text);
        const area = document.createElement('textarea');
        area.value = text;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        area.remove();
        return Promise.resolve();
      }

      /**
       * 侧栏那一行的图标：16 网格单色线稿（fill:none、stroke:currentColor、1.3），
       * 与宿主侧栏那一列的其它图标一致，深浅主题跟随文字色。彩色瓦片只用于
       * 插件管理器的 icon.svg。
       */
      function PocketIcon({ size = 16 }) {
        return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
          h('rect', { x: 5.2, y: 1.8, width: 5.6, height: 11.2, rx: 2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 }),
          h('path', { d: 'M7.1 4.4h2', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
          h('circle', { cx: 8, cy: 10.8, r: 0.7, fill: 'currentColor' }),
        );
      }

      const GLYPHS = {
        server: [
          'M4 5.5h16v5H4z',
          'M4 13.5h16v5H4z',
          'M7 8h.01',
          'M7 16h.01',
        ],
        globe: [
          'M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 0 0 0-17z',
          'M3.5 12h17',
          'M12 3.5c2.3 2.3 3.6 5.3 3.6 8.5s-1.3 6.2-3.6 8.5c-2.3-2.3-3.6-5.3-3.6-8.5S9.7 5.8 12 3.5z',
        ],
        phone: [
          'M8 2.8h8a2 2 0 0 1 2 2v14.4a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4.8a2 2 0 0 1 2-2z',
          'M10 6h4',
          'M10 18.5h4',
        ],
        shield: [
          'M12 3l7 3v5c0 4.4-3 7.4-7 9-4-1.6-7-4.6-7-9V6z',
          'm9 12 2 2 4-4',
        ],
        chevron: ['m8 10 4 4 4-4'],
        check: ['m6 12 4 4 8-8'],
        plug: ['M9 7V3.5M15 7V3.5', 'M7 7h10v4a5 5 0 0 1-10 0z', 'M12 16v4.5'],
        bolt: ['M13 2.5 5 13.5h6.2L11 21.5l8-11h-6.2z'],
        display: [
          'M3.5 5.5h17v11h-17z',
          'M9 20h6',
          'M12 16.5V20',
        ],
      };

      function LineIcon({ name, size = 16, className }) {
        const paths = GLYPHS[name] ?? GLYPHS.server;
        return h('svg', {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          className,
        }, paths.map((d, index) => h('path', { key: index, d })));
      }

      function StatusPill({ tone, label }) {
        return h('span', { className: `dsh-pk-pill ${tone}` },
          h('i', { className: 'dsh-pk-pill-dot' }),
          label,
        );
      }

      function Switch({ checked, onChange, disabled }) {
        return h('button', {
          type: 'button',
          role: 'switch',
          'aria-checked': checked === true,
          className: `dsh-pk-switch${checked === true ? ' on' : ''}`,
          disabled,
          onClick: () => onChange(checked !== true),
        }, h('span', { className: 'dsh-pk-switch-thumb' }));
      }

      function DisplayRow({ label, description, checked, onChange, disabled }) {
        return h('div', { className: 'dsh-pk-toggle-row' },
          h('div', { className: 'dsh-pk-toggle-copy' },
            h('span', { className: 'dsh-pk-toggle-label' }, label),
            h('span', { className: 'dsh-pk-toggle-desc' }, description),
          ),
          h(Switch, { checked, onChange, disabled }),
        );
      }

      function Picker({ value, options, onChange, disabled, placeholder }) {
        const [open, setOpen] = useState(false);
        const root = useRef(null);
        const current = options.find((option) => option.value === value);

        useEffect(() => {
          if (!open) return undefined;
          const onPointer = (event) => {
            if (root.current !== null && !root.current.contains(event.target)) setOpen(false);
          };
          const onKey = (event) => {
            if (event.key === 'Escape') setOpen(false);
          };
          document.addEventListener('pointerdown', onPointer);
          document.addEventListener('keydown', onKey);
          return () => {
            document.removeEventListener('pointerdown', onPointer);
            document.removeEventListener('keydown', onKey);
          };
        }, [open]);

        return h('div', { className: 'dsh-pk-picker', ref: root },
          h('button', {
            type: 'button',
            className: `dsh-pk-picker-btn${open ? ' open' : ''}`,
            disabled,
            'aria-haspopup': 'listbox',
            'aria-expanded': open,
            onClick: () => setOpen((next) => !next),
            onKeyDown: (event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setOpen(true);
              }
            },
          },
          h('span', { className: 'dsh-pk-picker-copy' },
            h('span', { className: 'dsh-pk-picker-value' }, current?.label ?? placeholder ?? ''),
            current?.description !== undefined ? h('span', { className: 'dsh-pk-picker-desc' }, current.description) : null,
          ),
          h(LineIcon, { name: 'chevron', size: 14, className: 'dsh-pk-picker-chevron' }),
          ),
          open
            ? h('div', { className: 'dsh-pk-menu', role: 'listbox' },
              options.map((option) => h('button', {
                key: option.value,
                type: 'button',
                role: 'option',
                'aria-selected': option.value === value,
                className: `dsh-pk-menu-item${option.value === value ? ' selected' : ''}`,
                onClick: () => {
                  setOpen(false);
                  onChange(option.value);
                },
              },
              h('span', { className: 'dsh-pk-menu-copy' },
                h('span', { className: 'dsh-pk-menu-label' }, option.label),
                option.description !== undefined ? h('span', { className: 'dsh-pk-menu-desc' }, option.description) : null,
              ),
              option.value === value ? h(LineIcon, { name: 'check', size: 15, className: 'dsh-pk-menu-check' }) : null,
              )))
            : null,
        );
      }

      function statusTone(tunnel) {
        if (tunnel.state === 'online') return 'on';
        if (tunnel.state === 'starting') return 'warn busy';
        if (tunnel.state === 'error') return 'err';
        return '';
      }

      function tunnelLabel(tunnel) {
        if (tunnel.state === 'online') return LANG.tunnelOnline;
        if (tunnel.state === 'starting') return LANG.tunnelStarting;
        if (tunnel.state === 'error') return LANG.tunnelError;
        return LANG.tunnelOff;
      }

      function UrlRow({ label, url }) {
        const [copied, setCopied] = useState(false);
        if (typeof url !== 'string' || url.length === 0) return null;
        const copy = () => {
          void copyText(url).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          });
        };
        return h('div', { className: 'dsh-pk-url' },
          h('span', { className: 'dsh-pk-url-label' }, label),
          h('span', { className: 'dsh-pk-url-text', title: url }, url),
          h('div', { className: 'dsh-pk-url-actions' },
            h('a', { className: 'dsh-pk-url-action', href: url, target: '_blank', rel: 'noopener noreferrer' }, LANG.open),
            h('button', { className: 'dsh-pk-url-action', onClick: copy }, copied ? LANG.copied : LANG.copy),
          ),
        );
      }

      function QrCard({ label, qr, emptyLabel }) {
        let host = '';
        if (qr?.url !== undefined) {
          try {
            host = new URL(qr.url).host;
          } catch {
            host = qr.url;
          }
        }
        return h('div', { className: 'dsh-pk-qr-card' },
          h('div', { className: 'dsh-pk-qr-card-head' },
            h('span', { className: 'dsh-pk-qr-card-label' }, label),
            qr?.image ? h('span', { className: 'dsh-pk-qr-badge' }, LANG.qrScan) : null,
          ),
          qr?.image
            ? h('img', { src: qr.image, alt: label })
            : h('div', { className: 'dsh-pk-qr-empty' },
              h(LineIcon, { name: 'phone', size: 24 }),
              h('span', null, emptyLabel),
            ),
          h('div', { className: 'dsh-pk-qr-host', title: qr?.url ?? '' }, qr?.image ? host : emptyLabel),
        );
      }

      function PocketPage() {
        const [status, setStatus] = useState(undefined);
        const [error, setError] = useState('');
        const [busy, setBusy] = useState('');
        const [toast, setToast] = useState('');
        const [view, setView] = useState('overview');
        const [provider, setProvider] = useState('cloudflared');
        const [sshHost, setSshHost] = useState('');
        const [displayDraft, setDisplayDraft] = useState(undefined);
        const timer = useRef(0);

        useEffect(() => {
          if (status === undefined) return;
          setProvider(status.tunnel?.mode === 'ssh' ? 'ssh' : 'cloudflared');
          setSshHost(typeof status.tunnel?.sshHost === 'string' ? status.tunnel.sshHost : '');
        }, [status?.tunnel?.mode, status?.tunnel?.sshHost]);

        useEffect(() => {
          if (status?.display === undefined) return;
          // 只在首次拿到状态时初始化草稿；3 秒轮询不要覆盖用户正在编辑的值。
          setDisplayDraft((draft) => draft ?? status.display);
        }, [status?.display]);

        const refresh = useCallback(async () => {
          try {
            const next = await call('status');
            setStatus(next);
            setError('');
          } catch (failure) {
            setError(String(failure?.message ?? failure));
          }
        }, []);

        useEffect(() => {
          void refresh();
          timer.current = setInterval(() => {
            if (document.visibilityState === 'visible') void refresh();
          }, 3000);
          return () => clearInterval(timer.current);
        }, [refresh]);

        useEffect(() => {
          if (toast.length === 0) return undefined;
          const handle = setTimeout(() => setToast(''), 2200);
          return () => clearTimeout(handle);
        }, [toast]);

        const action = async (name, body) => {
          setBusy(name);
          try {
            const next = await call(name, body ?? {});
            setStatus(next);
            if (name === 'set-display' && next?.display !== undefined) setDisplayDraft(next.display);
            setError('');
            return next;
          } catch (failure) {
            setError(String(failure?.message ?? failure));
            return undefined;
          } finally {
            setBusy('');
          }
        };

        const switchSurface = (mode) => {
          void action('set-surface', { surface: mode }).then((next) => {
            if (next?.surface !== mode) return;
            // 手机上（直通页面里的面板）直接刷新最直观；桌面窗口只提示，别打断当前工作。
            if (window.matchMedia('(max-width: 768px)').matches) window.location.reload();
            else setToast(LANG.surfaceSwitched);
          });
        };

        const rotate = () => {
          if (!window.confirm(LANG.rotateConfirm)) return;
          void action('rotate-token');
        };

        const switchProvider = () => {
          if (provider === 'ssh' && sshHost.trim().length === 0) {
            setError(LANG.serverRequired);
            return;
          }
          setError('');
          void action('switch-tunnel', { provider, sshHost: sshHost.trim() });
        };

        const draftDisplay = displayDraft ?? status?.display ?? {
          truncateTools: true,
          truncateAssistant: true,
          truncateReasoning: true,
          limit: 6000,
        };
        const patchDisplay = (key, value) => {
          setDisplayDraft((draft) => ({ ...(draft ?? draftDisplay), [key]: value }));
        };
        const saveDisplay = () => {
          const limit = Number(draftDisplay.limit);
          if (!Number.isFinite(limit) || limit < 500 || limit > 50000) {
            setError(LANG.displayRange);
            return;
          }
          setError('');
          void action('set-display', {
            display: {
              truncateTools: draftDisplay.truncateTools !== false,
              truncateAssistant: draftDisplay.truncateAssistant !== false,
              truncateReasoning: draftDisplay.truncateReasoning !== false,
              limit: Math.round(limit),
            },
          });
        };

        if (status === undefined) {
          return h('div', { className: 'dsh-pk' },
            h('div', { className: 'dsh-pk-head' },
              h('div', { className: 'dsh-pk-head-main' },
                h('h2', { className: 'dsh-pk-title' }, LANG.title),
                h('div', { className: 'dsh-pk-sub' }, LANG.subtitle),
              ),
            ),
            h('div', { className: 'dsh-pk-center' }, error.length > 0 ? error : LANG.loading),
          );
        }

        const tunnel = status.tunnel ?? { state: 'off', log: [] };
        const urls = status.server?.urls ?? { local: '', lan: [] };
        const lan = Array.isArray(urls.lan) ? urls.lan : [];
        const lanOptions = Array.isArray(urls.lanOptions) ? urls.lanOptions : [];
        const lanSelected = typeof urls.lanSelected === 'string' ? urls.lanSelected : '';
        const tone = statusTone(tunnel);
        const isStarting = tunnel.state === 'starting';
        const isOnline = tunnel.state === 'online';
        const legacyQr = typeof status.qr?.image === 'string' ? { url: status.qr.url, image: status.qr.image } : null;
        const publicQr = status.qr?.public ?? (isOnline ? legacyQr : null);
        const lanQr = status.qr?.lan ?? (isOnline ? null : legacyQr);
        const providerName = tunnel.provider === 'cloudflared'
          ? LANG.cloudflaredShort
          : tunnel.provider === 'ssh'
            ? LANG.ownServer
            : tunnel.provider ?? '-';
        const publicHost = typeof urls.publicUrl === 'string'
          ? urls.publicUrl.replace(/^https?:\/\//u, '').split('/')[0]
          : tunnelLabel(tunnel);
        const selectedLan = lanOptions.find((option) => option.address === lanSelected);
        const providerOptions = [
          { value: 'cloudflared', label: LANG.cloudflared, description: LANG.cloudflaredDesc },
          { value: 'ssh', label: LANG.ownServer, description: LANG.ownServerDesc },
        ];
        const lanPickerOptions = [
          { value: '', label: LANG.lanAuto, description: LANG.lanAutoDesc },
          ...lanOptions.map((option) => ({
            value: option.address,
            label: option.address,
            description: `${option.name}${option.virtual ? ` · ${LANG.lanVirtual}` : ''}`,
          })),
        ];
        const stat = (label, value, sub) => h('div', { className: 'dsh-pk-stat' },
          h('span', { className: 'dsh-pk-stat-label' }, label),
          h('b', { className: 'dsh-pk-stat-value' }, value),
          h('span', { className: 'dsh-pk-stat-sub' }, sub),
        );
        const awake = status.awake ?? { supported: false, active: false, error: null };
        const toggleAwake = () => {
          void action('keep-awake', { enabled: awake.active !== true });
        };

        const surfaceValue = status.surface === 'desktop' ? 'desktop' : 'mobile';
        const mobileLayoutOn = status.mobileLayout !== false;
        const surfaceOptions = status.desktopAvailable === false
          ? [{ value: 'mobile', label: LANG.surfaceMobile, description: LANG.surfaceMobileDesc }]
          : [
            { value: 'mobile', label: LANG.surfaceMobile, description: LANG.surfaceMobileDesc },
            { value: 'desktop', label: LANG.surfaceDesktop, description: LANG.surfaceDesktopDesc },
          ];

        const statsRow = h('div', { className: 'dsh-pk-stats' },
          stat(LANG.serverCard, status.server?.listening ? LANG.online : LANG.offline, `:${String(status.server?.port ?? '-')} · ${status.server?.host ?? '-'}`),
          stat(LANG.publicEntry, providerName, isOnline ? publicHost : tunnelLabel(tunnel)),
          stat(LANG.lanIp, selectedLan?.name ?? LANG.lanAuto, selectedLan?.address ?? `${lanOptions.length} ${LANG.lan}`),
        );

        const serverCard = h('section', { className: 'dsh-pk-card' },
          h('div', { className: 'dsh-pk-card-top' },
            h('span', { className: 'dsh-pk-card-icon' }, h(LineIcon, { name: 'server', size: 16 })),
            h('div', { className: 'dsh-pk-card-heading' },
              h('span', { className: 'dsh-pk-card-title' }, LANG.serverCard),
              h('span', { className: 'dsh-pk-card-sub' }, LANG.serverCardHint),
            ),
            h(StatusPill, { tone: status.server?.listening ? 'on' : '', label: status.server?.listening ? LANG.listening : LANG.stopped }),
          ),
          h('dl', { className: 'dsh-pk-kv' },
            h('dt', null, LANG.port), h('dd', null, String(status.server?.port ?? '-')),
            h('dt', null, LANG.bind), h('dd', null, status.server?.host ?? '-'),
          ),
          h('div', { className: 'dsh-pk-field' },
            h('span', { className: 'dsh-pk-field-label' }, LANG.lanIp),
            h(Picker, {
              value: lanSelected,
              options: lanPickerOptions,
              disabled: busy !== '',
              onChange: (value) => void action('set-lan', { address: value }),
            }),
            h('span', { className: 'dsh-pk-hint' }, LANG.lanHint),
          ),
          h('div', { className: 'dsh-pk-card-footer' },
            h('a', {
              className: 'dsh-pk-textlink',
              href: lan[0] ?? urls.local,
              target: '_blank',
              rel: 'noopener noreferrer',
            }, LANG.openPhone),
          ),
        );

        const tunnelCard = h('section', { className: 'dsh-pk-card' },
          h('div', { className: 'dsh-pk-card-top' },
            h('span', { className: 'dsh-pk-card-icon' }, h(LineIcon, { name: 'globe', size: 16 })),
            h('div', { className: 'dsh-pk-card-heading' },
              h('span', { className: 'dsh-pk-card-title' }, LANG.tunnelCard),
              h('span', { className: 'dsh-pk-card-sub' }, LANG.tunnelCardHint),
            ),
            h(StatusPill, { tone, label: tunnelLabel(tunnel) }),
          ),
          h('div', { className: 'dsh-pk-field' },
            h('span', { className: 'dsh-pk-field-label' }, LANG.publicEntry),
            h(Picker, {
              value: provider,
              options: providerOptions,
              disabled: busy !== '',
              onChange: setProvider,
            }),
            h('span', { className: 'dsh-pk-hint' }, LANG.publicEntryHint),
          ),
          provider === 'ssh'
            ? h('div', { className: 'dsh-pk-field' },
              h('span', { className: 'dsh-pk-field-label' }, LANG.serverAddress),
              h('div', { className: 'dsh-pk-input-shell' },
                h(LineIcon, { name: 'server', size: 15 }),
                h('input', {
                  className: 'dsh-pk-input',
                  value: sshHost,
                  placeholder: LANG.serverAddress,
                  disabled: busy !== '',
                  onChange: (event) => setSshHost(event.target.value),
                }),
              ),
              h('span', { className: 'dsh-pk-hint' }, LANG.serverAddressHint),
            )
            : null,
          h('div', { className: 'dsh-pk-actions' },
            h('button', {
              className: 'dsh-pk-btn primary block',
              disabled: busy !== '' || (provider === 'ssh' && sshHost.trim().length === 0),
              onClick: switchProvider,
            }, busy === 'switch-tunnel' ? LANG.switching : LANG.switchTunnel),
          ),
          tunnel.error !== undefined ? h('div', { className: 'dsh-pk-err' }, tunnel.error) : null,
          h('div', { className: 'dsh-pk-actions' },
            isOnline || isStarting
              ? h('button', { className: 'dsh-pk-btn', disabled: busy !== '', onClick: () => void action('tunnel-stop') }, LANG.stop)
              : h('button', { className: 'dsh-pk-btn primary', disabled: busy !== '', onClick: () => void action('tunnel-start') }, LANG.start),
            isOnline || tunnel.state === 'error'
              ? h('button', { className: 'dsh-pk-btn', disabled: busy !== '', onClick: () => void action('tunnel-restart') }, LANG.restart)
              : null,
          ),
          provider === 'ssh' ? h('div', { className: 'dsh-pk-note' }, LANG.sshHint) : null,
          Array.isArray(tunnel.log) && tunnel.log.length > 0
            ? h('details', { className: 'dsh-pk-details' },
              h('summary', null, LANG.log),
              h('pre', { className: 'dsh-pk-log' }, tunnel.log.slice(-8).join('\n')),
            )
            : null,
        );

        const awakeCard = h('section', { className: 'dsh-pk-card' },
          h('div', { className: 'dsh-pk-card-top' },
            h('span', { className: 'dsh-pk-card-icon' }, h(LineIcon, { name: 'bolt', size: 16 })),
            h('div', { className: 'dsh-pk-card-heading' },
              h('span', { className: 'dsh-pk-card-title' }, LANG.awakeCard),
              h('span', { className: 'dsh-pk-card-sub' }, LANG.awakeHint),
            ),
            h(StatusPill, { tone: awake.active ? 'on' : '', label: awake.active ? LANG.awakeOn : LANG.awakeOff }),
          ),
          h('div', { className: 'dsh-pk-field' },
            h('span', { className: 'dsh-pk-hint' }, awake.supported === false
              ? LANG.awakeUnsupported
              : awake.active ? LANG.awakeActiveHint : LANG.awakeIdleHint),
          ),
          awake.error !== undefined && awake.error !== null
            ? h('div', { className: 'dsh-pk-err' }, String(awake.error))
            : null,
          h('div', { className: 'dsh-pk-actions' },
            h('button', {
              className: awake.active ? 'dsh-pk-btn' : 'dsh-pk-btn primary',
              disabled: busy !== '' || awake.supported === false,
              onClick: toggleAwake,
            }, busy === 'keep-awake' ? LANG.switching : (awake.active ? LANG.awakeDisable : LANG.awakeEnable)),
          ),
          h('div', { className: 'dsh-pk-note' }, LANG.awakeNote),
        );

        const connectCard = h('section', { className: 'dsh-pk-card dsh-pk-connect-card' },
          h('div', { className: 'dsh-pk-card-top' },
            h('span', { className: 'dsh-pk-card-icon' }, h(LineIcon, { name: 'phone', size: 16 })),
            h('div', { className: 'dsh-pk-card-heading' },
              h('span', { className: 'dsh-pk-card-title' }, LANG.connectCard),
              h('span', { className: 'dsh-pk-card-sub' }, LANG.connectHint),
            ),
            isOnline ? h(StatusPill, { tone: 'on', label: LANG.online }) : null,
          ),
          h('div', { className: 'dsh-pk-connect' },
            h('div', { className: 'dsh-pk-qr-group' },
              h(QrCard, { label: LANG.public, qr: publicQr, emptyLabel: LANG.qrPublicEmpty }),
              h(QrCard, { label: LANG.lan, qr: lanQr, emptyLabel: LANG.qrLanEmpty }),
            ),
            h('div', { className: 'dsh-pk-links' },
              h(UrlRow, { label: LANG.local, url: urls.local }),
              isOnline ? h(UrlRow, { label: LANG.public, url: urls.publicUrl }) : null,
              lan.length === 0
                ? h('div', { className: 'dsh-pk-empty' }, LANG.noLan)
                : lan.map((url, index) => h(UrlRow, { key: `${url}-${index}`, label: LANG.lan, url })),
              h('div', { className: 'dsh-pk-note' }, LANG.warning),
            ),
          ),
        );

        const securityCard = h('section', { className: 'dsh-pk-security' },
          h('div', { className: 'dsh-pk-security-main' },
            h('span', { className: 'dsh-pk-card-icon' }, h(LineIcon, { name: 'shield', size: 16 })),
            h('div', { className: 'dsh-pk-card-heading' },
              h('span', { className: 'dsh-pk-card-title' }, LANG.securityCard),
              h('span', { className: 'dsh-pk-card-sub' }, LANG.tokenHint),
            ),
            h('code', { className: 'dsh-pk-token' }, `${String(status.token ?? '').slice(0, 6)}…${String(status.token ?? '').slice(-4)}`),
          ),
          h('button', { className: 'dsh-pk-btn danger', disabled: busy !== '', onClick: rotate }, LANG.rotate),
        );

        const surfaceCard = h('section', { className: 'dsh-pk-card' },
          h('div', { className: 'dsh-pk-card-top' },
            h('span', { className: 'dsh-pk-card-icon' }, h(LineIcon, { name: 'display', size: 16 })),
            h('div', { className: 'dsh-pk-card-heading' },
              h('span', { className: 'dsh-pk-card-title' }, LANG.surfaceCard),
              h('span', { className: 'dsh-pk-card-sub' }, LANG.surfaceHint),
            ),
          ),
          h('div', { className: 'dsh-pk-field' },
            h(Picker, {
              value: surfaceValue,
              options: surfaceOptions,
              disabled: busy !== '',
              onChange: switchSurface,
            }),
            h('span', { className: 'dsh-pk-hint' }, status.desktopAvailable === false
              ? LANG.surfaceUnavailable
              : LANG.surfaceNote),
          ),
        );

        const displayCard = h('section', { className: 'dsh-pk-card' },
          h('div', { className: 'dsh-pk-card-top' },
            h('span', { className: 'dsh-pk-card-icon' }, h(LineIcon, { name: 'display', size: 16 })),
            h('div', { className: 'dsh-pk-card-heading' },
              h('span', { className: 'dsh-pk-card-title' }, LANG.displayCard),
              h('span', { className: 'dsh-pk-card-sub' }, LANG.displayHint),
            ),
          ),
          h('div', { className: 'dsh-pk-field' },
            h(DisplayRow, {
              label: LANG.displayTools,
              description: LANG.displayToolsDesc,
              checked: draftDisplay.truncateTools !== false,
              disabled: busy !== '',
              onChange: (value) => patchDisplay('truncateTools', value),
            }),
            h(DisplayRow, {
              label: LANG.displayAssistant,
              description: LANG.displayAssistantDesc,
              checked: draftDisplay.truncateAssistant !== false,
              disabled: busy !== '',
              onChange: (value) => patchDisplay('truncateAssistant', value),
            }),
            h(DisplayRow, {
              label: LANG.displayReasoning,
              description: LANG.displayReasoningDesc,
              checked: draftDisplay.truncateReasoning !== false,
              disabled: busy !== '',
              onChange: (value) => patchDisplay('truncateReasoning', value),
            }),
          ),
          h('div', { className: 'dsh-pk-field' },
            h('span', { className: 'dsh-pk-field-label' }, LANG.displayLimit),
            h('div', { className: 'dsh-pk-display-limit' },
              h('input', {
                className: 'dsh-pk-input',
                type: 'number',
                min: 500,
                max: 50000,
                step: 500,
                value: String(draftDisplay.limit ?? ''),
                disabled: busy !== '',
                onChange: (event) => patchDisplay('limit', event.target.value),
              }),
              h('span', null, LANG.displayLimitUnit),
            ),
            h('span', { className: 'dsh-pk-hint' }, LANG.displayNote),
          ),
          h('div', { className: 'dsh-pk-actions' },
            h('button', {
              className: 'dsh-pk-btn primary block',
              disabled: busy !== '',
              onClick: saveDisplay,
            }, busy === 'set-display' ? LANG.switching : LANG.displaySave),
          ),
        );

        const narrowCard = h('section', { className: 'dsh-pk-card' },
          h('div', { className: 'dsh-pk-card-top' },
            h('span', { className: 'dsh-pk-card-icon' }, h(LineIcon, { name: 'phone', size: 16 })),
            h('div', { className: 'dsh-pk-card-heading' },
              h('span', { className: 'dsh-pk-card-title' }, LANG.narrowCard),
              h('span', { className: 'dsh-pk-card-sub' }, LANG.narrowHint),
            ),
            h(StatusPill, { tone: mobileLayoutOn ? 'on' : '', label: mobileLayoutOn ? LANG.narrowOn : LANG.narrowOff }),
          ),
          h('div', { className: 'dsh-pk-field' },
            h(DisplayRow, {
              label: LANG.narrowLabel,
              description: LANG.narrowDesc,
              checked: mobileLayoutOn,
              disabled: busy !== '',
              onChange: (value) => void action('set-mobile-layout', { enabled: value }),
            }),
            h('span', { className: 'dsh-pk-hint' }, LANG.narrowNote),
          ),
        );

        return h('div', { className: 'dsh-pk' },
          h('div', { className: 'dsh-pk-head' },
            h('div', { className: 'dsh-pk-head-row' },
              h('div', { className: 'dsh-pk-head-main' },
                h('div', { className: 'dsh-pk-eyebrow' }, 'POCKET · REMOTE'),
                h('h2', { className: 'dsh-pk-title' }, LANG.title),
                h('div', { className: 'dsh-pk-sub' }, LANG.subtitle),
              ),
              h('div', { className: 'dsh-pk-head-actions' },
                h(StatusPill, { tone, label: tunnelLabel(tunnel) }),
                h('button', { className: 'dsh-pk-btn', onClick: () => void refresh() }, LANG.refresh),
              ),
            ),
            h('div', { className: 'dsh-pk-tabs' },
              h('button', {
                type: 'button',
                className: `dsh-pk-tab${view === 'overview' ? ' active' : ''}`,
                onClick: () => setView('overview'),
              }, LANG.tabOverview),
              h('button', {
                type: 'button',
                className: `dsh-pk-tab${view === 'settings' ? ' active' : ''}`,
                onClick: () => setView('settings'),
              }, LANG.tabSettings),
            ),
          ),
          h('div', { className: 'dsh-pk-body' },
            view === 'overview'
              ? h(React.Fragment, null,
                statsRow,
                h('div', { className: 'dsh-pk-grid' }, serverCard, tunnelCard, awakeCard),
                connectCard,
                securityCard,
              )
              : h(React.Fragment, null,
                surfaceCard,
                surfaceValue === 'mobile' ? displayCard : narrowCard,
                h('div', { className: 'dsh-pk-settings-note' },
                  surfaceValue === 'mobile'
                    ? `${LANG.settingsScope} ${LANG.settingsFootnote}`
                    : LANG.displayOnlyMobile),
              ),
            error.length > 0 ? h('div', { className: 'dsh-pk-err' }, error) : null,
          ),
          toast.length > 0 ? h('div', { className: 'dsh-pk-toast' }, toast) : null,
        );
      }

      const inject = ['slots'];

      function apply(ctx) {
        const slots = ctx.get('slots');
        if (slots === undefined) return;

        ctx.effect(() => {
          const style = createOwnedStyle(CSS);
          return () => style.remove();
        }, 'pocket: styles');

        slots.inject('sidebar.panellist', () => slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 2,
          label: () => LANG.panel,
        }, PocketIcon));

        slots.inject('main', () => slots.register({
          name: 'main',
          key: PANEL_ID,
        }, PocketPage));
      }

      return { apply, inject };
    },
  });
}
})();

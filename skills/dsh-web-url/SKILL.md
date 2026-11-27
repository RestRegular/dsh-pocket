---
name: dsh-web-url
description: "Use when you need the running DeepSeek Harness (DSH) Web GUI URL — to open the Web UI in a browser, debug a plugin/UI in the browser, check whether the Web server is up, or find the local port/base URL for RPC. Also use when a user says \"the Web page / this GUI / 调试插件 / 打开界面\" and needs the concrete http://127.0.0.1:<port> address."
---

# Get the running DSH Web GUI URL

Goal: obtain the concrete `http://127.0.0.1:<port>` address of the **currently running** DSH Web UI, fast and without guessing. The port is chosen at runtime and changes between launches, so never hardcode it.

This skill ships with the `dsh-pocket` plugin, which also exposes the `pocket_share` tool referenced below.

## Fast path (use this first)

Every agent tool shell has the DSH Web URL injected as an environment variable, and the running session's context also names it as **"Current DeepSeek Harness Web GUI URL"**.

1. Check the system context line first — if it says `Current DeepSeek Harness Web GUI URL: http://...`, that is the answer. No command needed.
2. Otherwise read the env var:

```powershell
$env:DSH_WEB_URL
```

```bash
printf '%s\n' "$DSH_WEB_URL"
```

It looks like `http://127.0.0.1:62591`. That is both the Web GUI URL and the origin to use for browser debugging.

### Why this is authoritative

`DSH_WEB_URL` is set by DSH itself for the agent's tool processes, so it always points at the Web server of the running installation that owns this session. It beats reading config files or scanning ports, both of which can be stale or ambiguous.

## The dsh-pocket plugin and `pocket_share`

The `@restregular/dsh-pocket` plugin (随身访问 / Pocket Access) provides a `pocket_share` tool when installed and enabled. It returns three **Pocket** access URLs, each carrying a 128-bit `?token=`:

- `local` — `http://127.0.0.1:<pocket-port>/?token=…` (the Pocket port, 8790 on this machine — **not** the GUI port)
- `lan` — a same-Wi-Fi address
- `public` — a tunnel address (Cloudflare / localtunnel / localhost.run / self-hosted SSH), only when a tunnel is online

It also reports whether the tunnel is online.

### Which URL do you actually need?

| Need | Use |
|---|---|
| Debug a plugin's UI/panel in a local browser (the common case) | `DSH_WEB_URL` — the full desktop GUI |
| Open the session on a phone, or reach DSH remotely | `pocket_share` `public` / `lan` |
| Tool-based lookup when env var and context line are both missing | `pocket_share` `local`, only if the tool is present |

Important: the Pocket `local` URL serves the **mobile** Pocket UI on a different port. Do not report it as "the DSH Web GUI URL". To reach the full desktop GUI through Pocket, use its **desktop passthrough** (`GET /__pocket/surface?to=desktop`), which reverse-proxies the complete desktop GUI.

`pocket_share` exists only in sessions where dsh-pocket is installed and enabled. If it is not in your toolset, fall back to the env var / context line — never assume every agent has it.

## Using the URL for debugging

- **Open the UI in the browser:** call `browser_open` with the full URL. Use `browser_see` / `browser_text` / `browser_screenshot` to inspect it, and `browser_act` to click or type.
- **After a client-plugin change:** client-plugin HMR reloads without a manual refresh **only** while `pnpm run dev:web` is running from the same DSH checkout to rebuild the bundle. Verify that watcher before promising live updates. Everything else (apps/web shell, plain packages) needs a rebuild plus a page refresh at this URL.
- **Do not start a replacement server** to "make the URL work". If a server is genuinely needed, use a managed background job and verify its exact URL.

### Important: the Web UI requires auth

A bare HTTP request to the URL returns **401 Unauthorized** — DSH protects the Web UI with a session cookie (`dsh-auth-<base64url(sha256(authority))>`). Therefore:

- For UI debugging, use the `browser_*` tools, which run in the logged-in browser context and already carry the cookie.
- Do **not** conclude the server is down from a 401. A 401 means it is up and answering.
- For programmatic HTTP/RPC calls you need the owner cookie and a signed body; see `references/fallbacks.md`.

## When the env var is missing

Read `references/fallbacks.md` for the ordered fallback chain (session context, the `pocket_share` tool, profile config, pocket state, listening-port scan) and the RPC call format. Keep the same rule: confirm the candidate actually answers, and never present an unverified port as fact.

## Quick checklist

- [ ] Read `DSH_WEB_URL` (or the "Current DeepSeek Harness Web GUI URL" context line) — do this first.
- [ ] Confirm it is a `http://127.0.0.1:<port>` address, not a LAN/public pocket URL.
- [ ] Use `browser_open` for UI work; expect 401 from plain `curl`/`Invoke-WebRequest`.
- [ ] Only if missing, follow `references/fallbacks.md` and verify the candidate before reporting it.

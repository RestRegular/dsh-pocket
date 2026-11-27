# Fallbacks when `DSH_WEB_URL` is unavailable

Use these in order. Every candidate must be **verified** before you report it — a stale config or a wrong process can give you a plausible but dead address.

## 1. Session context (no command)

The running session's system context usually contains:

> Current DeepSeek Harness Web GUI URL: `http://127.0.0.1:<port>`

If present, prefer it; it is produced by the same runtime as the env var.

## 1b. The `pocket_share` tool (only if dsh-pocket is installed)

If your toolset includes `pocket_share`, call it. It returns `local` / `lan` / `public` Pocket URLs plus tunnel status. These are **Pocket** access URLs, on the Pocket port (8790 here), each with a `?token=`:

- Good for phone access, remote access, or when the env var is genuinely missing.
- Not a substitute for the desktop GUI URL: the `local` one serves the mobile UI. For the full desktop GUI via Pocket use `/__pocket/surface?to=desktop`.
- The URLs contain a 128-bit bearer token — treat them as secrets; never paste them into public channels.

Never assume this tool exists in every agent session; it comes from the dsh-pocket plugin.

## 2. Pocket plugin state / profile config

Some builds expose the listening port through the profile or the pocket plugin:

- `~/.dsh/profiles/desktop/cordis.patch.yml` — entries such as `dsh-pocket` carry a `port`.
- `~/.dsh/pocket/state.json` — carries the pocket `token` and related endpoints.
- Profile config generally lives under `$DSH_PROFILE_DIR` (e.g. `C:\Users\32280\.dsh\profiles\desktop`).

These are useful cross-checks, but the port here may belong to the pocket service, not necessarily the Web GUI server. Treat it as a candidate, not a guarantee.

## 3. Scan listening ports of the DSH / Electron process

When neither of the above gives a verified answer, find the HTTP listener owned by the running DSH process:

```powershell
# Find the Electron/DSH processes, then their listening TCP ports
Get-Process | Where-Object { $_.ProcessName -match 'DeepSeek|electron|dsh' } | Select-Object Id,ProcessName
Get-NetTCPConnection -State Listen | Where-Object { $_.LocalAddress -eq '127.0.0.1' } |
  Select-Object LocalAddress,LocalPort,OwningProcess | Sort-Object LocalPort
```

Cross-reference the owning process id with the DSH process list. Probe the remaining candidates; the Web GUI server answers (with 401, not a connection error).

**Do not** scan or dump whole package trees, and **do not** unpack `app.asar` just to find the port. Config and env are cheaper and authoritative.

## Distinguish the different URLs

| Thing | Shape | Notes |
|---|---|---|
| Web GUI URL | `http://127.0.0.1:<port>` (GUI port, e.g. 62591) | What this skill is about; use with `browser_open`. |
| RPC base | `http://127.0.0.1:<port>` of the Host | Same origin shape but different route: `/api/<ns>/<method>`. |
| Pocket local | `http://127.0.0.1:8790/?token=…` | dsh-pocket mobile UI; different port/service. Desktop GUI via `/__pocket/surface?to=desktop`. |
| Pocket lan / public | LAN or tunnel URL with `?token=…` | From `pocket_share`; for phone/remote access, not local plugin debugging. |

The GUI port, the Host RPC port, and the Pocket port can all differ. Always start from `DSH_WEB_URL` for the GUI; do not substitute a Pocket or RPC port.

## RPC call format (when you truly need the Host API)

If fallback puts you on the Host RPC port and you need to call a Host method directly (this is **not** needed for normal UI debugging):

1. POST body is a Typert envelope:
   `{"type":"client-request","rpcId":"<uuid>","method":"<ns>/<method>","payload":{"args":{...}}}`
2. Add the owner cookie `dsh-auth-<base64url(sha256(authority))>` where `authority` is `127.0.0.1:<port>` (include port, no scheme). Value: `v1.<base64url(JSON{version,authority,issuedAt,expiresAt})>.<base64url(HMAC-SHA256(body, secret))>`; the secret comes from `~/.dsh/.credentials.yaml` at `records['client-connection/browser-session'].payload.secret` (base64url, 32 bytes).
3. Write JSON to a file and use `--data-binary "@file"`; inline JSON via PowerShell `curl` is often rejected as "body is not JSON".
4. Read the response with Node `fetch` + JSON, not a PowerShell pipe redirect (which writes UTF-16 and breaks `JSON.parse`).
5. Some methods wrap args: e.g. `archiveSession` / `unarchiveSession` expect `{request:{sessionId}}`, not a bare `sessionId`.

## Verify before reporting

```powershell
$r = Invoke-WebRequest -Uri $candidate -UseBasicParsing -TimeoutSec 5
"HTTP $($r.StatusCode)"   # 200/302/401 all mean the server is alive
```

A connection error means the candidate is wrong or the server is not running. A 401 is normal and expected.

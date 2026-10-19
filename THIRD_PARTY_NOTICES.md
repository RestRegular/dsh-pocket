# Third-party notices

## QR encoder — `lib/qrcode.js`

Vendored from [`qrcode-generator`](https://github.com/kazuhikoarase/qrcode-generator) by Kazuhiko Arase, via the self-contained ESM bundle in [`dsh-remote-tunnel-easy`](https://www.npmjs.com/package/dsh-remote-tunnel-easy) (MIT).

Original header:

```text
QRCode for JavaScript
Copyright (c) 2009 Kazuhiko Arase
URL: http://www.d-project.com/
Licensed under the MIT license:
  http://www.opensource.org/licenses/mit-license.php
```

## cloudflared binary (optional, not bundled)

The optional dependency `agentroam-cloudflared-win32-x64` (MIT packaging) ships the official [Cloudflare `cloudflared`](https://github.com/cloudflare/cloudflared) Windows x64 executable, which is licensed under the Apache License 2.0. The package's manifest records the upstream release version and SHA-256. This repository does not commit or redistribute the binary; it is installed by the package manager.

## localtunnel

The plugin can invoke a system-installed `lt` command. `localtunnel` is licensed under MIT and is not bundled here.

## ws

The Host service uses [`ws`](https://github.com/websockets/ws) (MIT) for the mobile WebSocket transport. It is installed as a normal npm dependency and is not vendored.

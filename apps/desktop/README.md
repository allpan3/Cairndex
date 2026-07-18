# Cairndex desktop shell

This package contains the cross-platform Tauri 2 host for the shared React SPA
in `apps/web`. It does not contain a second frontend.

## Development

Start a Cairndex server with the exact Vite origin explicitly trusted, then run:

```bash
cd apps/server
CAIRNDEX_CORS_EXTRA_ORIGINS=http://127.0.0.1:5173 \
  uv run uvicorn cairndex.main:app --reload --port 8000
```

```bash
cd apps/desktop
npm ci
npm run tauri dev
```

The first-run screen asks for the server URL and persists it in the Tauri store.
The Vite server and production bundle are both built from `apps/web` through
`tauri.conf.json`. Do not configure the Vite origin on a production server;
packaged builds use Tauri's custom-protocol origins. Protected libraries require
Settings → Pair this device to display a short code; approve it and select the
library scope from an unlocked same-origin web session. The delivered bearer is
stored with that scope in the Tauri store only for its issuing server. API calls
attach it only to approved library paths. Unscoped unprotected libraries remain
anonymous; an unscoped protected library asks the owner to pair again rather
than showing the browser-only passphrase form. Settings can forget the local
credential; revoke it from an owner web session to invalidate it on the server.

ADR-0017 narrows the loopback media relay to approved libraries plus read-only
stream, HLS, thumbnail, preview, storyboard, subtitle, and File Browser routes.
It rotates its capability path on configuration, rejects redirects and unknown
origins, bounds stalls/concurrency, and preserves known `Content-Length` values
for large 206 ranges. Browser mode continues to use same-origin cookies.
The macOS bundle declares local-network access and permits cleartext HTTP for
WKWebView content so an owner-configured private LAN server can be used; prefer
HTTPS beyond a trusted private network.

## Rust gates

```bash
cd apps/desktop/src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

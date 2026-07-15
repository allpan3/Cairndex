# Cairndex desktop shell

This package contains the cross-platform Tauri 2 host for the shared React SPA
in `apps/web`. It does not contain a second frontend.

## Development

Start a Cairndex server, then run:

```bash
cd apps/desktop
npm ci
npm run tauri dev
```

The first-run screen asks for the server URL and persists it in the Tauri store.
The Vite server and production bundle are both built from `apps/web` through
`tauri.conf.json`.

## Rust gates

```bash
cd apps/desktop/src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

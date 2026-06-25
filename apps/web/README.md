# Cairndex web

The Cairndex frontend: React + TypeScript (strict) + Vite. See the repo root
[`docs/development.md`](../../docs/development.md) for full setup; this README
covers the commands specific to this package.

## Commands

```bash
npm install        # install dependencies
npm run dev        # dev server on :5173, proxies /api -> http://localhost:8000
npm run build      # type-check (tsc -b) + production build
npm run preview    # preview the production build

npm run lint         # eslint (flat config)
npm run format       # prettier --write
npm run format:check # prettier --check
npm run typecheck    # tsc -b (no emit; strict mode)
npm run test         # vitest run (unit/component, jsdom)
npm run test:e2e     # playwright (boots its own dev server)
```

## Layout (Phase 0)

```text
src/
  api/client.ts   typed fetch wrapper over /api/v1 (Phase 0: health only)
  useHealth.ts    health-probe hook with loading/ok/error states
  App.tsx         minimal app shell
  App.test.tsx    component tests (Vitest + Testing Library)
e2e/              Playwright end-to-end specs
```

The richer data/routing layer (TanStack Query/Router, TanStack Virtual,
Radix UI) and the three-pane desktop shell arrive in the Phase 3 UI milestone
— see [`docs/STATUS.md`](../../docs/STATUS.md). Configuring the dev API proxy
target: set `VITE_API_PROXY_TARGET` (defaults to `http://localhost:8000`).

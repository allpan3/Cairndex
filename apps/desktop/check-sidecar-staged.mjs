// Fails a `tauri build` whose sidecar resource is a stale empty placeholder.
//
// `tauri.conf.json` stages `apps/server/packaging/dist/cairndex-sidecar` as a
// bundle resource, and tauri-build copies resources at *compile* time — so an
// empty directory is a legitimate affordance for `cargo check`, `cargo test`,
// and `tauri dev` (see docs/development.md). It stops being legitimate at
// bundling: the resource copier skips empty directories silently, so the build
// succeeds and produces an app whose local server is simply missing, surfacing
// much later as a `not_bundled` error in front of a user.
//
// Wired into `build.beforeBuildCommand`, which runs only for `tauri build`, so
// the empty-dir affordance is untouched everywhere else.

import { existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const binary = join(
  here,
  '..',
  'server',
  'packaging',
  'dist',
  'cairndex-sidecar',
  'cairndex-sidecar',
)

if (!existsSync(binary) || !statSync(binary).isFile()) {
  console.error(
    [
      '',
      'The local-server sidecar is not staged, so this build would produce an',
      'app with no local server (silently — the resource copier skips an empty',
      'directory).',
      '',
      'Build it first:',
      '',
      '    cd apps/server && uv run python packaging/build_sidecar.py',
      '',
      'An empty dist/cairndex-sidecar directory is fine for cargo check/test and',
      'tauri dev; it is not fine for a bundled app. See docs/development.md.',
      '',
    ].join('\n'),
  )
  process.exit(1)
}

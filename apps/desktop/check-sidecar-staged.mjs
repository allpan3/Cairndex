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

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
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

const expectedVersion = readFileSync(join(here, '..', '..', 'VERSION'), 'utf8').trim()
const serverRoot = join(here, '..', 'server')
const internal = join(dirname(binary), '_internal')
const stagedVersions = existsSync(internal)
  ? readdirSync(internal)
      .filter((name) => name.startsWith('cairndex_server-') && name.endsWith('.dist-info'))
      .map((name) => name.slice('cairndex_server-'.length, -'.dist-info'.length))
  : []

if (stagedVersions.length !== 1 || stagedVersions[0] !== expectedVersion) {
  console.error(
    [
      '',
      `The staged local-server sidecar is ${stagedVersions.join(', ') || 'unversioned'},`,
      `but this release is ${expectedVersion}. Rebuild it before bundling:`,
      '',
      '    cd apps/server && uv run python packaging/build_sidecar.py',
      '',
    ].join('\n'),
  )
  process.exit(1)
}

const inputs = [
  join(serverRoot, 'pyproject.toml'),
  join(serverRoot, 'uv.lock'),
  join(serverRoot, 'packaging', 'cairndex-sidecar.spec'),
  join(serverRoot, 'packaging', 'sidecar_entry.py'),
]
const pending = [join(serverRoot, 'src')]
while (pending.length > 0) {
  const directory = pending.pop()
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) pending.push(path)
    else if (entry.isFile()) inputs.push(path)
  }
}

const newestInput = Math.max(...inputs.map((path) => statSync(path).mtimeMs))
if (statSync(binary).mtimeMs < newestInput) {
  console.error(
    [
      '',
      'The staged local-server sidecar is older than the server source.',
      'Rebuild it before bundling:',
      '',
      '    cd apps/server && uv run python packaging/build_sidecar.py',
      '',
    ].join('\n'),
  )
  process.exit(1)
}

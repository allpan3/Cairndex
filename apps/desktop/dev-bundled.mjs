// One command to run the desktop shell against the bundled "This Computer"
// sidecar — the frozen PyInstaller build of apps/server that ships to users.
//
// The sidecar is a build artifact, not live source: change server code and the
// running desktop keeps serving the old binary, so a route added since the last
// build 404s in the desktop while the web app works. That trap is the whole
// reason this exists. This script rebuilds the sidecar *only when apps/server
// has changed since the last build*, then launches `tauri dev` pointed at the
// fresh binary via CAIRNDEX_SIDECAR_BIN (which overrides the stale copy Tauri
// staged into target/ at its last cargo build).
//
// For ordinary iteration prefer a source `:8000` server the desktop connects to
// (see the README) — that is live code with no rebuild. Reach for this only to
// exercise the self-contained bundle. Pass --force to rebuild unconditionally.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serverDir = join(here, "..", "server");
const binary = join(
  serverDir,
  "packaging",
  "dist",
  "cairndex-sidecar",
  "cairndex-sidecar",
);

// Newest mtime of the files a rebuild would fold in: the server source, the
// packaging scripts/spec, and the dependency manifest. Skips caches and dotfiles.
function newestMtime(dir, matches) {
  let newest = 0;
  if (!existsSync(dir)) return newest;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__pycache__" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory())
      newest = Math.max(newest, newestMtime(full, matches));
    else if (matches(entry.name))
      newest = Math.max(newest, statSync(full).mtimeMs);
  }
  return newest;
}

const binaryMtime = existsSync(binary) ? statSync(binary).mtimeMs : 0;
const sourceMtime = Math.max(
  newestMtime(join(serverDir, "src"), (name) => name.endsWith(".py")),
  newestMtime(
    join(serverDir, "packaging"),
    (name) => name.endsWith(".py") || name.endsWith(".spec"),
  ),
  existsSync(join(serverDir, "pyproject.toml"))
    ? statSync(join(serverDir, "pyproject.toml")).mtimeMs
    : 0,
);

const force = process.argv.includes("--force");
if (force || !existsSync(binary) || sourceMtime > binaryMtime) {
  const why = !existsSync(binary)
    ? "no build yet"
    : force
      ? "--force"
      : "apps/server changed";
  console.log(`• rebuilding the sidecar (${why})…`);
  execFileSync("uv", ["run", "python", "packaging/build_sidecar.py"], {
    cwd: serverDir,
    stdio: "inherit",
  });
} else {
  console.log("• sidecar is up to date — skipping the rebuild");
}

console.log("• launching `tauri dev` against the bundled sidecar");
const result = spawnSync("npx", ["tauri", "dev"], {
  cwd: here,
  stdio: "inherit",
  env: { ...process.env, CAIRNDEX_SIDECAR_BIN: binary },
});
process.exit(result.status ?? 1);

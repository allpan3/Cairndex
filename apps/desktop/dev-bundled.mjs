// Runs the frozen development sidecar with media tools shared from the cache
// Release resources are disabled for this invocation to avoid copies in target
// Server or packaging changes rebuild the isolated development bundle

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serverDir = join(here, "..", "server");
const binary = join(
  serverDir,
  "packaging",
  "dist",
  "development",
  "cairndex-sidecar",
  "cairndex-sidecar",
);

// Newest mtime of the files a rebuild would fold in: the server source, the
// packaging scripts/spec, and the dependency manifest; skips caches and dotfiles
function newestMtime(dir, matches) {
  let newest = 0;
  if (!existsSync(dir)) return newest;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (
      ["__pycache__", "build", "dist", "vendor"].includes(entry.name) ||
      entry.name.startsWith(".")
    )
      continue;
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

// A changed pin, missing cache, or stale link requires a fresh verified staging
function mediaToolsReady() {
  const platform = process.platform === "darwin" ? "macos" : process.platform;
  const arch = process.arch === "x64" ? "x86_64" : process.arch;
  const key = `${platform}-${arch}`;
  const manifest = JSON.parse(
    readFileSync(join(serverDir, "packaging", "ffmpeg-manifest.json")),
  );
  return ["ffmpeg", "ffprobe"].every((tool) => {
    const cached = join(serverDir, "packaging", "vendor", "ffmpeg", key, tool);
    const staged = join(dirname(binary), tool);
    return (
      existsSync(cached) &&
      existsSync(staged) &&
      realpathSync(staged) === realpathSync(cached) &&
      createHash("sha256").update(readFileSync(cached)).digest("hex") ===
        manifest.platforms[key]?.[tool]?.sha256
    );
  });
}

// A newly configured signer must replace an otherwise current ad-hoc build.
// Invalid or unavailable configuration stops the launch instead of falling back.
const signature = spawnSync(
  "uv",
  ["run", "python", "packaging/macos_signing.py", "check", binary],
  { cwd: serverDir, stdio: "inherit" },
);
if (signature.error || signature.status === null || signature.status > 1) {
  console.error("• sidecar signing configuration could not be verified");
  process.exit(2);
}
const signingStale = signature.status === 1;
const force = process.argv.includes("--force");
const mediaStale = !mediaToolsReady();
if (
  force ||
  mediaStale ||
  signingStale ||
  !existsSync(binary) ||
  sourceMtime > binaryMtime
) {
  const why = !existsSync(binary)
    ? "no build yet"
    : force
      ? "--force"
      : signingStale
        ? "signing identity changed"
        : mediaStale
          ? "media cache changed"
          : "apps/server changed";
  console.log(`• rebuilding the sidecar (${why})…`);
  execFileSync(
    "uv",
    ["run", "python", "packaging/build_sidecar.py", "--development"],
    {
      cwd: serverDir,
      stdio: "inherit",
    },
  );
} else {
  console.log("• sidecar is up to date — skipping the rebuild");
}

console.log("• launching `tauri dev` against the bundled sidecar");
const result = spawnSync(
  "npx",
  ["tauri", "dev", "--config", JSON.stringify({ bundle: { resources: null } })],
  {
    cwd: here,
    stdio: "inherit",
    env: { ...process.env, CAIRNDEX_SIDECAR_BIN: binary },
  },
);
process.exit(result.status ?? 1);

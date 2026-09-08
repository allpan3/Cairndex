// Exercise the development launcher without a GUI or real media
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Verify cache reuse, pin invalidation, and the exact no-resource Tauri invocation
test("development shares tools and never stages release resources", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cairndex-dev-test-")));
  try {
    const desktop = join(root, "apps", "desktop");
    const packaging = join(root, "apps", "server", "packaging");
    const bundle = join(packaging, "dist", "development", "cairndex-sidecar");
    const key = `${process.platform === "darwin" ? "macos" : process.platform}-${process.arch === "x64" ? "x86_64" : process.arch}`;
    const cache = join(packaging, "vendor", "ffmpeg", key);
    const bin = join(root, "bin");
    for (const dir of [desktop, bundle, cache, bin])
      mkdirSync(dir, { recursive: true });
    copyFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "dev-bundled.mjs"),
      join(desktop, "dev-bundled.mjs"),
    );
    const pins = {};
    for (const tool of ["ffmpeg", "ffprobe"]) {
      writeFileSync(join(cache, tool), tool);
      symlinkSync(join(cache, tool), join(bundle, tool));
      pins[tool] = { sha256: createHash("sha256").update(tool).digest("hex") };
    }
    writeFileSync(
      join(packaging, "ffmpeg-manifest.json"),
      JSON.stringify({ platforms: { [key]: pins } }),
    );
    writeFileSync(join(bundle, "cairndex-sidecar"), "synthetic executable");
    for (const command of ["uv", "npx"]) {
      writeFileSync(
        join(bin, command),
        `#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.TEST_LOG, JSON.stringify({command:${JSON.stringify(command)},args:process.argv.slice(2),binary:process.env.CAIRNDEX_SIDECAR_BIN})+'\\n');\n`,
      );
      chmodSync(join(bin, command), 0o755);
    }
    const log = join(root, "calls.jsonl");
    const run = () => {
      const result = spawnSync(
        process.execPath,
        [join(desktop, "dev-bundled.mjs")],
        {
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            TEST_LOG: log,
          },
          encoding: "utf8",
        },
      );
      assert.equal(result.status, 0, result.stderr);
      return readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
    };
    let calls = run();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "npx");
    assert.deepEqual(calls[0].args, [
      "tauri",
      "dev",
      "--config",
      JSON.stringify({ bundle: { resources: null } }),
    ]);
    assert.equal(calls[0].binary, join(bundle, "cairndex-sidecar"));
    writeFileSync(join(cache, "ffmpeg"), "tampered");
    calls = run();
    assert.equal(calls[1].command, "uv");
    assert.deepEqual(calls[1].args, [
      "run",
      "python",
      "packaging/build_sidecar.py",
      "--development",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

# Deployment

> Status: production packaging exists, and ADR-0008 has moved runtime/content
> state to a server-local registry plus portable per-library packages. See
> [ADR-0005](adr/0005-packaging-and-deployment.md) for the original packaging
> rationale and [ADR-0008](adr/0008-per-library-metadata-and-registry.md) for the
> current metadata model.

## Local development stack

`docker-compose.yml` (repo root) defines two services for local iteration:

- `server` — FastAPI app via `uvicorn --reload`, port `8000`, source
  bind-mounted from `apps/server`.
- `web` — Vite dev server, port `5173`, source bind-mounted from `apps/web`.

```bash
docker compose up --build
docker compose down
```

This is for local iteration only (source bind-mounts, hot reload). It is not how
the app runs in production.

## Production deployment (NAS / self-host)

One hardened container serves the API and the built frontend on port `8000`.

```bash
cp .env.example .env          # then edit MEDIA_HOST_PATH and bind addr/port
docker compose -f docker-compose.prod.yml up --build -d
```

Then open the bound address (default `http://127.0.0.1:8000`), use the app's
library manager to create or register the mounted path, and run **Update**. A
Cairndex library root contains its portable `.cairndex/` package:

```text
/storage/media/
  media files...
  .cairndex/
    manifest.json
    library.db
    cache/
```

The production library mount must be writable because Cairndex creates and
updates `.cairndex/manifest.json`, `.cairndex/library.db`, and generated cache
files. This does **not** mean normal app flows mutate source media: the current
product path remains metadata-only for source files and does not move, rename,
delete, or rewrite them.

### Topology

- **Single image** (`infra/docker/production.Dockerfile`): a multi-stage build
  compiles the SPA, installs the locked backend, and produces a slim
  `python:3.12-slim` runtime that serves the built frontend from FastAPI
  (`CAIRNDEX_STATIC_DIR=/app/web`) behind `/api`. `ffmpeg`/`ffprobe` are
  installed for scanning, thumbnails, and subtitle conversion.
- **Non-root**: runs as a fixed UID/GID `10001:10001`. Give the app-data volume
  and the library root enough permissions for that id to write `/data` and the
  library's `.cairndex/` package.
- **Writable app data**: the `cairndex-data` named volume at `/data` holds the
  server-local `registry.db`, job state, and backups. It is not portable content
  metadata.
- **Writable library root**: `MEDIA_HOST_PATH` is mounted at `/storage/media`.
  The app writes only the `.cairndex/` package and generated cache during the
  current MVP path; source media operations remain metadata-only.
- **Hardening**: read-only container root filesystem, `tmpfs` `/tmp`, and
  `no-new-privileges`. Writable state is limited to mounted volumes.

### Environment variables

Configuration is read from the environment (prefix `CAIRNDEX_`); see
`.env.example` and `apps/server/src/cairndex/core/config.py`.

| Variable                           | Default (image) | Purpose                                                                                                                                                            |
| ---------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CAIRNDEX_ENVIRONMENT`             | `production`    | Free-form environment label.                                                                                                                                       |
| `CAIRNDEX_DATA_DIR`                | `/data`         | Server-local app-data dir (`registry.db`, backups, runtime state).                                                                                                 |
| `CAIRNDEX_STATIC_DIR`              | `/app/web`      | Built SPA dir the backend serves. Unset -> backend serves API only (dev).                                                                                          |
| `CAIRNDEX_CORS_EXTRA_ORIGINS`      | _unset_         | Comma-separated exact HTTP(S) origins allowed in addition to packaged Tauri origins. Use `http://127.0.0.1:5173` only while running `tauri dev`; never enable it on a production server. |
| `CAIRNDEX_WORKER_ENABLED`          | `true`          | Run the in-process scan/probe/thumbnail worker.                                                                                                                    |
| `CAIRNDEX_STORYBOARDS`             | `true`          | Enable storyboard/trickplay generation and serving. Set to `off` to skip/hide storyboards.                                                                         |
| `CAIRNDEX_STORYBOARD_MIN_DURATION` | `10`            | Minimum probed video duration, in seconds, before storyboard generation is attempted.                                                                              |
| `CAIRNDEX_TRANSCODE_MAX_SESSIONS`  | `2`             | Max concurrent interactive HLS remux/transcode sessions (ADR-0014). Starting one beyond this returns HTTP 429. Raise for multi-video-wall use.                     |
| `CAIRNDEX_TRANSCODE_IDLE_TIMEOUT`  | `60`            | Seconds without a playlist/segment fetch before an HLS session is killed and its transcode dir deleted.                                                            |
| `CAIRNDEX_FFMPEG_HWACCEL`          | _unset_         | Optional ffmpeg hardware-accelerated _decode_ for transcode sessions: `vaapi`, `qsv`, or `videotoolbox`. Unset/`none` = software decode; encoding stays `libx264`. |

Advanced HLS knobs (rarely changed): `CAIRNDEX_TRANSCODE_SEGMENT_WAIT`
(default `20`, seconds to wait for a segment the encoder is producing before
restarting ffmpeg), `CAIRNDEX_TRANSCODE_AHEAD_WINDOW` (default `5`, segments a
request may lead the encoder before a far-seek restart), and
`CAIRNDEX_TRANSCODE_KEYFRAME_TIMEOUT` (default `60`, ffprobe deadline for the
one-time remux keyframe scan).

**Transcode scratch directory.** Interactive HLS sessions write fMP4 segments
under `{CAIRNDEX_DATA_DIR}/transcode/{session_id}/` — server-local, ephemeral
runtime state, **never** inside a library package (ADR-0014). It is created on
demand, reaped when sessions end/idle/shut down, and safe to wipe between runs;
no backup is needed. Size it for roughly `MAX_SESSIONS × the video length being
watched` (a session holds the segments it has produced so far — a whole movie's
worth in the worst case of a fully-scrubbed transcode); on the `/data` volume a
few GB of headroom is ample for the default 2-session bound.

Compose-only host knobs (`.env`): `CAIRNDEX_BIND_ADDR` (default `127.0.0.1`),
`CAIRNDEX_PORT` (default `8000`), and `MEDIA_HOST_PATH` (host Cairndex library
root mounted at `/storage/media`).

### Backups

ADR-0008 split persistent state across multiple SQLite DBs:

- registry DB: `/data/registry.db` inside the container;
- each library DB: `<library-root>/.cairndex/library.db`, for example
  `/storage/media/.cairndex/library.db`.

Back up the registry plus every library DB you care about. Generated cache files
under `.cairndex/cache/` are reproducible and can usually be regenerated.

`infra/backup.sh` makes a consistent hot copy of one SQLite DB using SQLite's
online backup API and integrity-checks it:

```bash
# Back up server-local registry state.
docker exec <container> /app/infra/backup.sh /data/registry.db /data/backups

# Back up a mounted library's portable content metadata.
docker exec <container> /app/infra/backup.sh /storage/media/.cairndex/library.db /data/backups

# Pull the copies off the box.
docker cp <container>:/data/backups ./backups
```

Restore is a file copy while the app is **stopped**: `down`, replace the relevant
`registry.db` and/or `library.db` with backup copies, then `up -d`.

### Remote access and security

The compose file binds to `127.0.0.1` by default. Do **not** expose this directly
to the public internet. For remote access, reach it over a private network or
Tailscale, or front it with a reverse proxy that adds authentication.

An **optional per-library owner passphrase lock** (ADR-0010) is available as a
lightweight guardrail. Each library independently chooses no lock or a passphrase;
enable one with:

```bash
uv run python -m cairndex.devtools.set_passphrase --library-root /path/to/library
# remove it later with --clear
```

Only a PBKDF2 hash is stored (in the library's portable manifest); unlocking is a
server-side session bound to an opaque HTTP-only cookie and scoped to that one
library (unlocking one protected library never unlocks another). Sessions are
in-memory, so a restart re-locks everything. Setting or replacing a passphrase
also revokes every existing device token scoped to that library; affected
devices must pair again after the library is unlocked.

Paired desktop/TV clients may instead send an ADR-0015 device token in the
`Authorization: Bearer` header. Tokens are scoped to owner-selected library ids,
stored only as salted hashes in `registry.db`, and remain valid across restarts
until revoked from Settings → Devices or invalidated by a scoped library's
passphrase change. Never put a device token in a URL.

The D2 desktop shell starts the device side of pairing from Settings and stores
the delivered token plus approved library ids in its Tauri store, bound to the
normalized server URL that issued it. A separate unlocked same-origin browser
session remains the owner approval surface. The shell sends the bearer only to
approved library paths. Unscoped unprotected libraries stay anonymous; unscoped
protected libraries require another pairing approval.

ADR-0017's loopback-only media relay accepts only approved read-only media
routes, exact shell origins, and non-redirecting responses. Its capability path
rotates whenever server auth changes; read stalls, workers, and the queue are
bounded, and known byte-range lengths are preserved. Revocation or a scoped
passphrase change invalidates the server credential immediately. Forget the
local token in desktop Settings, then pair again and revoke superseded device
rows from the web Settings → Devices page.

Desktop library mappings are client-local configuration, not server registry
paths. For a NAS library, mount the same portable library over SMB/NFS on the
desktop, then use Settings → Libraries to locate that mounted root. Cairndex
requires the mounted `.cairndex/manifest.json` UUID to match the server library
before saving the mapping. Reveal/default-app actions remain hidden for unmapped
libraries and return **Volume not mounted** if the saved mount disappears. No
absolute desktop path or host-launch command is sent to the server.

This is a **private LAN/Tailscale guardrail, not public-internet hardening**: it
adds no rate limiting, lockout, or TLS. Direct public-internet exposure remains
unsupported without a separate hardened reverse proxy. Full multi-user accounts
are out of scope.

## Desktop app distribution (macOS)

### What Cairndex ships today

Cairndex is single-owner software built from source, so the release build is
**ad-hoc signed** — not Developer ID signed, not notarized. On Apple Silicon the
linker ad-hoc signs every binary automatically, which is why packaged builds have
run locally since D1 with no certificate and no Apple Developer Program
membership. That is the supported model:

```bash
cd apps/desktop
npm run tauri build
```

This produces both bundle targets:

- `src-tauri/target/release/bundle/macos/Cairndex.app` — the app itself;
- `src-tauri/target/release/bundle/dmg/Cairndex_<version>_<arch>.dmg` — a
  drag-to-Applications disk image.

Build a single target with `npm run tauri build -- --bundles app` (or `dmg`).
**CI deliberately passes `--bundles app`**: Tauri's DMG bundler drives Finder over
AppleScript and is a known flake source on headless runners, and CI only needs to
prove the app compiles and bundles. The DMG is a release/local artifact.

### A DMG is packaging, not trust

The DMG exists for install ergonomics — drag-to-Applications instead of "find the
.app in a build directory". **It changes nothing about Gatekeeper.** An unsigned,
un-notarized DMG copied to another Mac still triggers the "cannot be opened
because the developer cannot be verified" warning, and that Mac's owner must
approve it once under System Settings → Privacy & Security → *Open Anyway*.

Do not read the DMG as a substitute for signing. It is not one. You can see the
difference directly — this is the real output for an ad-hoc build:

```bash
codesign -dv src-tauri/target/release/bundle/macos/Cairndex.app
# → Signature=adhoc
# → TeamIdentifier=not set

spctl --assess --type open --context context:primary-signature -vv \
  src-tauri/target/release/bundle/dmg/Cairndex_0.1.0_aarch64.dmg
# → rejected
# → source=no usable signature
```

That `rejected` is expected and harmless on the machine that built it; it is what
another Mac's Gatekeeper reports before the owner approves it once.

One more consequence of the ad-hoc model: **an ad-hoc signature changes on every
rebuild.** Some macOS privacy grants are keyed to the code signature rather than
the bundle identifier, so a rebuilt app may occasionally re-prompt for a
permission it was already granted — for Cairndex that is most likely the
local-network prompt the shell already triggers when reaching a LAN server.
Re-approving is expected under this model, not a sign of misconfiguration; a
stable Developer ID signature is what removes it.

### If you install from the DMG: the `cairndex://` scheme has several claimants

Installing creates a **second** copy of the app. The build directory keeps its own
at `apps/desktop/src-tauri/target/release/bundle/macos/Cairndex.app`, recreated by
every build, and both register the `cairndex://` URL scheme. LaunchServices then
picks a registrant by its own heuristics, so `open cairndex://…` may cold-launch
the **stale build-directory copy** rather than the one in `/Applications`.

The DMG build itself adds another: `bundle_dmg.sh` stages the app on a temporary
`/Volumes/dmg.XXXXXX` volume, and that path stays registered after the volume is
gone. On this repository's machine, after one DMG build and no installation, the
registrants were:

```bash
lsregister=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
"$lsregister" -dump | awk '/^[[:space:]]*path:/ { p=$2 }
                           /claimed schemes:.*cairndex:/ { print p }' | sort -u
# → /Users/…/target/release/bundle/macos/Cairndex.app
# → /Volumes/dmg.f9FEwK/Cairndex.app        ← dead mount point, still claimed
```

Why this matters beyond launching the wrong build: if the `/Applications` copy is
already running and LaunchServices launches a *different* copy for the link, the
single-instance plugin forwards only **argv** to the running instance — and on
macOS a deep link arrives as an Apple Event, not argv. The link parks in the
process that immediately exits, and is silently lost.

So when the `/Applications` copy should own the scheme, **unregister every other
claimant by path**. `lsregister -u` is the tool that works, including for paths on
volumes that no longer exist:

```bash
# Eject the DMG if it is still mounted — a mounted image is itself a claimant.
hdiutil detach /Volumes/Cairndex

# Unregister each unwanted path from the dump above. This works on dead paths too.
"$lsregister" -u /Volumes/dmg.XXXXXX/Cairndex.app
"$lsregister" -u "$(git rev-parse --show-toplevel)/apps/desktop/src-tauri/target/release/bundle/macos/Cairndex.app"

# Optionally also delete the build-directory bundle; it returns on the next build,
# and each rebuild re-registers it, so expect to repeat the -u above after builds.
rm -rf "$(git rev-parse --show-toplevel)/apps/desktop/src-tauri/target/release/bundle/macos/Cairndex.app"
```

Two things that do **not** work, both verified on macOS 26:

- `lsregister -kill` — removed by Apple ("the `-kill` option has been removed
  because it was dangerous and no longer useful"). Any recipe you find online that
  rebuilds the database this way is stale.
- `lsregister -gc` — runs without error but does not drop these stale claims.

Note the `git rev-parse --show-toplevel` in the paths above: the build-directory
bundle must be addressed absolutely, since a relative path silently resolves
against whatever directory you happen to be in and the `rm` then does nothing.

Re-run the `-dump` command above to confirm only the intended path claims the
scheme. **Any deep-link testing must be done against whichever copy is meant to
own it** — otherwise a passing or failing result says nothing about the app the
user actually runs. Expect to re-check after every `tauri build`, since each one
recreates and re-registers the build-directory bundle.

### When you actually need Developer ID signing

Ad-hoc signing stops being sufficient the moment a build has to run on a **second
Mac** or reach **someone else's hands** — distribution to other people, a
download link, or anything where "click Open Anyway" is not an acceptable
instruction. That threshold is what justifies the **Apple Developer Program at
$99/year**; below it, the fee buys Cairndex nothing. A free Apple ID yields only a
"Personal Team" certificate, which signs locally and still fails Gatekeeper
elsewhere, so there is no free path to a distributable build.

### The signing pipeline (inert until configured)

The build reads its signing configuration from the environment. **With these
variables unset, the build behaves exactly as documented above** — ad-hoc signed,
no notarization, no extra steps. Nothing needs to be re-plumbed when you decide to
sign; you only set the variables.

One-time setup, after enrolling in the Apple Developer Program:

1. In Xcode (Settings → Accounts → Manage Certificates) or on
   developer.apple.com, create and install a **Developer ID Application**
   certificate into your login keychain. Confirm it is there:

   ```bash
   security find-identity -v -p codesigning
   # → "Developer ID Application: Your Name (TEAMID1234)"
   ```

2. Store notarization credentials in the keychain so no secret ever appears in a
   shell history, a build script, or this repository:

   ```bash
   xcrun notarytool store-credentials "cairndex-notary" \
     --apple-id "you@example.com" \
     --team-id "TEAMID1234" \
     --password "<app-specific password from appleid.apple.com>"
   ```

   Use an **app-specific password**, never your Apple ID password.

Then build with the environment populated:

```bash
cd apps/desktop
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID1234)"
# Only consumed if Tauri performs notarization itself; the manual notarytool
# route below already carries the team id inside the keychain profile. Exported
# anyway so either route works without editing this recipe.
export APPLE_TEAM_ID="TEAMID1234"
npm run tauri build
```

Tauri signs the `.app` with that identity. Whether its bundler also codesigns the
**DMG container** (as opposed to only the app inside it) is version-dependent and
has not been exercised here, so check the first time you run this path —
notarization wants the container signed too:

```bash
codesign -dv "$DMG" 2>&1 | grep -E 'Signature|Authority' || \
  codesign --sign "$APPLE_SIGNING_IDENTITY" --timestamp "$DMG"
```

Then notarize and staple the DMG:

```bash
DMG=src-tauri/target/release/bundle/dmg/Cairndex_0.1.0_aarch64.dmg
xcrun notarytool submit "$DMG" --keychain-profile "cairndex-notary" --wait
xcrun stapler staple "$DMG"
```

Stapling embeds the notarization ticket so the DMG validates on a Mac with no
network access. Verify the result before handing it to anyone:

```bash
spctl --assess --type open --context context:primary-signature -vv "$DMG"
# → source=Notarized Developer ID
xcrun stapler validate "$DMG"
```

Notes for when this is picked up:

- Hardened Runtime is required for notarization. Set it in
  `tauri.conf.json` under `bundle.macOS.hardenedRuntime` (Tauri enables it by
  default when signing) and add entitlements there if a future capability needs
  one; Cairndex currently needs none beyond the default.
- Notarization requires the app to be signed with a **Developer ID Application**
  certificate specifically — an "Apple Development" certificate is rejected.
- The `dev.cairndex.app` bundle identifier is owner-specified and must match the
  identifier registered under the team.
- Auto-update is **deferred**, not part of this pipeline (see
  [plan 3 §3](plans/03-macos-desktop-app.md)): the repository is private with no
  releases, and Tauri's updater fetches release assets over plain HTTPS, so it
  would require embedding a token in the shipped app.

### Linux and Windows

Out of scope for v1 but kept cheap by the cross-platform rules in plan 3 §2.1.
Linux packaging would be AppImage/deb with no notarization concept; Windows would
want an Authenticode certificate on the same env-gated pattern.

## Health check

`GET /api/v1/health` returns `{"status": "ok", "api_features": [...], ...}` and backs the image's
Docker `HEALTHCHECK` (and any NAS container-manager liveness probe). No
authentication is required for this endpoint.

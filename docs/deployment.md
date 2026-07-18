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

## Health check

`GET /api/v1/health` returns `{"status": "ok", "api_features": [...], ...}` and backs the image's
Docker `HEALTHCHECK` (and any NAS container-manager liveness probe). No
authentication is required for this endpoint.

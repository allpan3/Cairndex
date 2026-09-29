# Deployment

## Current storage qualification

See the [storage qualification matrix](storage-qualification.md) before deployment.
Local Linux ARM64 containers have passing synthetic evidence. Current mounted-SMB
portable creation, NAS application qualification, real provider delivery and current
native client acceptance remain incomplete. Earlier NAS/SMB checkpoints below
apply only to their recorded revisions.

## Portable library storage

[ADR-0035](adr/0035-portable-library-format.md) defines the supported application
format. Normal Create produces a complete portable catalog. Open refuses the old
`cairndex.library` format. No automatic conversion or source mutation occurs.
Working databases, drafts, jobs and caches are private to the serving instance;
the library folder contains its descriptor and immutable metadata history.
Shared ORM and media utilities also support synthetic conversion fixtures. They
do not enable legacy library admission.

Optional access settings are independent per library and server. Hashes live in
`CAIRNDEX_DATA_DIR/library-access/<library_uuid>.json`, outside recovery generations.
Recovery keeps these destination settings. Manage libraries provides access and
private backup controls. See [private recovery](replica-recovery.md) for coverage,
Release, review, activation and explicit retry.


Production packaging is defined by [ADR-0005](adr/0005-packaging-and-deployment.md).
[ADR-0035](adr/0035-portable-library-format.md) defines the supported library format.

## Replica storage boundary

The application keeps SQLite, WAL, drafts and unsent events under
`CAIRNDEX_DATA_DIR/replicas`, outside provider folders. Back up this private state
consistently in addition to immutable package artifacts; copying the package alone
cannot recover unpublished edits or drafts. Protocol-two preview/save/recovery jobs
also live privately; queued jobs resume after restart, and interrupted saves retry
with the same operation identity. The shared app lists retained jobs for recovery.
Disposable rollback exports retain a separate `replica-recovery.db` alongside the
legacy recovery copy; these exports never activate a real library. Do not clone private state into a
second author. Use the [private replica recovery command](replica-recovery.md)
for coherent backups, verified restoration and explicit generation activation
after Release/shutdown. It also ships as `cairndex-sidecar replica-recovery`.
Backups remain outside server data and provider trees; registry credentials and
legacy conversion archives have separate backup/rebinding responsibilities.
Exchange requires macOS/Linux POSIX directory descriptors and atomic
hard-link publication; unsupported storage reports a retryable exchange failure.
No provider or Windows qualification, real-library conversion, deployment or source
write capability is implied. See the [contract](replica-migration.md).

## Local development stack

`docker-compose.yml` (repo root) is the containerized *development* stack —
bind-mounted source, hot reload on both halves, its own registry volume, and a
scratch library mount. It is documented in
[development.md](development.md#running-with-docker), not here; it is not how
the app runs in production.

## Production deployment (NAS / self-host)

One hardened container serves the API and the built frontend on port `8000`.

The [NAS verification checkpoint](nas-verification.md) covers an isolated Linux
NAS production image, non-root/read-only-root permissions, clean shutdown,
process recovery and Mac browser/native clients. NAS-local hard links succeed;
the tested Mac SMB mount refuses native hard links, so the macOS server uses the
bounded direct-SMB publication path described below. Same-share
Rename/Move/Trash/Undo pass through their ordinary mounted paths.
This bounded topology is not a claim about all NAS/SMB configurations, power loss
or public internet exposure.

The tested Mac mount refuses native hard links, exclusive rename and cloning.
On macOS, Cairndex uses [ADR-0034](adr/0034-mounted-smb-copy-publication.md)'s
signed, encrypted direct-SMB publication path for Copy/Replace/Undo while media
and metadata remain mounted normally. The matching SMB login must already be
saved in macOS Keychain for the kernel-reported server and account; the first use
may show a Keychain access prompt. Missing or denied credentials safely refuse
the operation. NAS-hosted serving remains a separate option. See
[publication verification](nas-verification.md#mounted-smb-copy-publication).

**The server pulls a published image.**
[`deploy/docker-compose.yml`](../deploy/docker-compose.yml) is the whole
deployment — every setting carries a working default, so it needs no `.env`
beside it and can be pasted straight into a NAS Docker UI's Project / Stack /
Compose section, which is how most of these boxes are administered.
[`deploy/README.md`](../deploy/README.md) is the runbook: install both ways,
permissions, updating, backups. Nothing else goes on the box — no checkout, no
build toolchain, no source.

```bash
docker compose up -d          # or start the project from the NAS UI
```

Note that the image will **not** appear in a NAS Docker app's image-search tab.
Those search Docker Hub; this image is on GHCR. Pulling it by full name in a
compose file is unaffected — the search index and the pull are unrelated
mechanisms — and a Project created from the compose file is managed by the UI
exactly like one created from a search result.

**Building from source is the fallback**, for running an unreleased branch or a
change you have not published. The compose file at the repository root builds
the same image locally, and needs a checkout on the server:

```bash
cp .env.example .env          # then edit CAIRNDEX_LIBRARY_PATH and bind addr/port
docker compose -f docker-compose.prod.yml up --build -d
```

Building on the NAS gives you its architecture for free. To build elsewhere —
an Apple Silicon Mac for an amd64 NAS — see
[Building for the NAS from another machine](#building-for-the-nas-from-another-machine).

### Publishing the image

`.github/workflows/publish-image.yml` pushes to
`ghcr.io/allpan3/cairndex`. It runs on a version tag (`v1.2.3` publishes `1.2.3`,
`1.2`, and moves `latest` unless it is a prerelease) and on manual dispatch,
which publishes exactly the tag you name and never touches `latest`. It does
**not** run on pushes to `main`: publication should be a deliberate act, the same
reason `release.yml` produces a *draft* release rather than a published one.

The image is smoke-tested before it is pushed, not after — built and tagged in
the runner's local daemon, put through `infra/docker/smoke.sh`, checked so every
final registry tag still resolves to that exact tested image ID, and only then
pushed. There is no second build between test and publication: a rebuild could
resolve a changed base image or dependency and publish bytes that were never
run. Publishing first and testing after would leave a broken image pullable in
between, with `:latest` already moved.

After the smoke test, the workflow generates an SPDX JSON SBOM from that local
candidate and uploads it as a workflow artifact. Once the tested tags are
pushed, it resolves their shared immutable `sha256:` manifest digest and binds
both build provenance and the SBOM to that digest as GHCR attestations. A tag is
therefore only a convenient name; the digest is the release identity that the
attestations verify.

Two things to know about GHCR:

- **Check the package is public before the server tries to pull.** Published
  from a public repository it inherits that visibility (verified 2026-07-30, on
  the first publish). If a package ever does come out private, `docker pull`
  fails with an authentication error rather than "not found", and the fix is
  *Packages → cairndex → Package settings → Change visibility*.
- **Only `linux/amd64` is published**, which is the deployment target. Adding
  `linux/arm64` is a one-line change on the push step plus a QEMU setup action —
  and it costs an emulated build of the whole Node and Python stack on every
  release, which is why it is not on. The comment in the workflow says where.

Then open the bound address, use the app's library manager to create or register
a path under the mount, and run **Update**.

### Mounts and libraries are not the same thing

Cairndex can see exactly what you mount, and nothing else. Mounts live under
`/libraries`, one per **share**:

```text
/libraries/
  main/         <- /volume1/media on the host
  archive/      <- /volume2/archive
```

A mount is not a library. **One mount can hold any number of libraries**, and
they are created live in the app — no compose change, no restart:

```text
/libraries/main/films/.cairndex/       <- one library
/libraries/main/photos/.cairndex/      <- another
```

There is no allow-list of paths in the server: any directory it can see can
become a library, and creating one will make the directory if it does not exist.
So you never enumerate libraries in compose — you enumerate shares. You come
back to the compose file only when files live somewhere the container cannot see
at all, and then you add a sibling mount:

```yaml
- "/volume2/archive:/libraries/archive:rw"
```

**Add mounts as siblings; do not re-path an existing one.** The registry records
the path each library was registered under, as the container sees it, so moving
a mount orphans every library inside it and they must be registered again. That
is also why every mount is a child of `/libraries` rather than `/libraries`
itself — a deployment that starts with one share can gain a second without
disturbing the first.

The paths you type in the app are container paths (`/libraries/main/films`), not
host paths. Typing the host path gives "root path does not exist", which is the
app being accurate from where it is standing.

Each library root contains source media and `.cairndex/manifest.json` plus
immutable seed and metadata objects. Private SQLite databases, drafts, jobs and
caches stay under `CAIRNDEX_DATA_DIR`. Metadata publication requires a writable
package. Source media can remain read-only. Source Copy, Rename, Move, Replace,
Trash and Undo are unavailable for portable libraries.

### Topology

- **Single image** (`infra/docker/production.Dockerfile`): a multi-stage build
  compiles the SPA, installs the locked backend, and produces a slim
  `python:3.12-slim` runtime that serves the built frontend from FastAPI
  (`CAIRNDEX_STATIC_DIR=/app/web`) behind `/api`. `ffmpeg`/`ffprobe` are
  installed for scanning, thumbnails, and subtitle conversion.
- **Non-root**: runs as UID/GID `10001:10001` by default, and **runs correctly
  as any uid** — `user: "1000:1000"` in compose lets a deployment write as its
  owner instead, needing no ownership changes on the host and leaving what
  Cairndex creates readable to that owner's backups. The image writes only to
  `/data`, `/tmp` and the library mounts, all supplied from outside, which is
  what makes the override safe; `smoke.sh` exercises the image under a foreign
  uid so it stays true. The one constraint is that `/data` must then be a bind
  mount, since a named volume inherits the image's ownership. Otherwise: give the app-data volume
  and the library root enough permissions for that id to write `/data` and the
  library's `.cairndex/` package. On Linux that id is literal in both
  directions: a bind mount preserves real uids, so everything Cairndex creates
  in the library is owned by `10001:10001` **on the host too**, and your own
  account may not be able to read all of it because private files use restricted permissions.
  Plan for it in [Backups](#backups): share a group with `10001`, or read the
  package from inside a container. Docker Desktop for macOS remaps ownership to
  whoever invoked it, so a trial on a Mac will not show you any of this.
- **Writable app data**: the `cairndex-data` named volume at `/data` holds the
  server-local registry, private working databases, credentials, jobs and caches.
  Both production compose files mount `/backups` separately and set
  `CAIRNDEX_PRIVATE_BACKUP_DIR=/backups`. The default sibling of `/data`
  is unsuitable for a read-only container root without this configuration.
- **Writable library mounts**: `CAIRNDEX_LIBRARY_PATH` is mounted at
  `/libraries/main`, and further shares mount beside it under `/libraries`. The
  app publishes immutable metadata into each library's `.cairndex/` package.
  Generated caches stay in private server storage. Source media remains unchanged.
- **Hardening**: read-only container root filesystem, `tmpfs` `/tmp`, and
  `no-new-privileges`. Writable state is limited to mounted volumes.
- **Startup preflight**: the entrypoint refuses to start if `CAIRNDEX_DATA_DIR`
  is not writable by uid 10001. It warns, without refusing, when nothing is
  mounted under `/libraries` at all, and for each mount that is not writable. A
  wholly read-only library mount is unsupported: browsing needs writable
  metadata publication under `.cairndex`. Protected source media
  with a writable metadata package is supported. An unwritable `/data` is not,
  and without the check it surfaces much later as an
  opaque SQLite "unable to open database file" from whichever request happened
  to touch the registry first. This is the most common NAS misconfiguration,
  because a bind-mounted host directory arrives with the host's ownership.
- **Graceful stop matters**: `stop_grace_period` is 30s. Shutdown drains private
  work and closes serving bindings. A forced stop can interrupt operations;
  inspect retained recovery tasks before an explicit retry.

- **Bounded logs**: `json-file` with `max-size: 10m`, `max-file: 3`. Unbounded
  container logs are a slow way to fill a NAS volume.

### Building for the NAS from another machine

The image is architecture-agnostic — every base it uses is multi-arch — so
building it *on* the NAS needs no special handling and is the simplest path.
Building on an Apple Silicon Mac for an amd64 NAS needs an explicit platform,
because Docker otherwise builds for the host's architecture:

```bash
just docker-build-nas              # docker buildx build --platform linux/amd64 …
```

That leaves `cairndex:nas` in the local daemon. With no registry between the two
machines, ship it over SSH:

```bash
docker save cairndex:nas | gzip | ssh nas 'gunzip | docker load'
```

Then on the NAS, point compose at the loaded image (`image: cairndex:nas`) and
bring it up without `--build`. With a registry available, swap `--load` for
`--push` in the recipe and pull on the NAS instead.

Cross-building is emulated, so it is slower than building natively on the NAS —
prefer building there when you can.

### Verifying an image actually works

```bash
just docker-smoke
```

The smoke script creates a disposable portable library, accepts a synthetic
Update review, checks media ranges and HLS, and verifies that the package has no
mutable database after shutdown. It also checks a separate container under the
invoking user ID. Building an image alone does not verify runtime behavior.

CI first runs `infra/docker/build-and-check.sh`. That gate creates synthetic
private-data canaries in every ignored runtime, environment, dependency, and
sidecar packaging path, builds both development contexts and the production
context, checks all three images for a leaked canary, rejects residual Python
caches, verifies the production image contains the project and copyleft license
notices, and rejects any context larger than 50 MiB by default. The production
stage copies only installed runtime source and those notices from its build
stages. CI then passes that exact image explicitly to the smoke test.

This exists because *building* an image proves very little. The Docker CI job
was green for a month while the production entrypoint ran a migration command
that no longer did anything and the dev image had no ffmpeg at all.

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
| `CAIRNDEX_STORYBOARD_SAMPLING`     | `keyframe`      | `keyframe` decodes only keyframes, so tiles land on the keyframe at or before each sample point and scrubbing is as fine as the source's GOP. `exact` decodes every frame for exact interval boundaries — several times slower per video, and worth it only for a local library (docs/performance.md). The mode is part of the storyboard cache key, so changing it retires every cached sheet — trickplay is unavailable for a library until an Update/storyboards run rebuilds it. |
| `CAIRNDEX_TRANSCODE_MAX_SESSIONS`  | `2`             | Max concurrent interactive HLS remux/transcode sessions (ADR-0014). Starting one beyond this returns HTTP 429. Raise for multi-video-wall use.                     |
| `CAIRNDEX_PREFER_HLS`              | `false`         | Prefer copy-only HLS over direct progressive delivery when the client supports HLS. Production Compose defaults this to `true`; set `false` only when remote direct playback is proven reliable. Video is not re-encoded. |
| `CAIRNDEX_TRANSCODE_IDLE_TIMEOUT`  | `60`            | Seconds without a playlist/segment fetch before an HLS session is killed and its transcode dir deleted.                                                            |
| `CAIRNDEX_FFMPEG_HWACCEL`          | _unset_         | Optional ffmpeg hardware-accelerated _decode_ for transcode sessions: `vaapi`, `qsv`, or `videotoolbox`. Unset/`none` = software decode; encoding stays `libx264`. |
| `CAIRNDEX_WRITE_MODE`              | `allowed`       | Deployment master switch for guarded file operations (ADR-0013). `allowed` lets the per-library opt-in decide; `disabled` forces every library read-only.          |
| `CAIRNDEX_IMPORT_MAX_BYTES`        | `0`             | Largest single file that may be uploaded into a library. `0` = no limit.                                                                                          |
| `CAIRNDEX_TRASH_RETENTION_DAYS`    | `0`             | Days a trashed file is kept before it is emptied for good (ADR-0013 §3.2). `0` = keep forever. The sweep runs when a library opens, never on a request path.       |

**Media tools**: `CAIRNDEX_FFMPEG_PATH` and `CAIRNDEX_FFPROBE_PATH` name the
binaries explicitly. Unset, they are resolved from `PATH` and then from the
conventional install prefixes (`/opt/homebrew/bin`, `/usr/local/bin`,
`/opt/local/bin`, `/usr/bin`, `/bin`). The fallback exists because a macOS app
launched from Finder inherits launchd's minimal `PATH`, which has no Homebrew
prefix — without it a desktop-spawned server reports "ffmpeg not found" on a
machine that plainly has ffmpeg. A shell-launched server or container behaves
exactly as before.

**Desktop sidecar** (ADR-0018 §5): `CAIRNDEX_LOCAL_TOKEN` puts the server in
*sidecar mode* — every `/api/v1` request must present it as a bearer token
(`/api/v1/health` stays open so the shell can wait for readiness). This is for a
loopback server the desktop app spawns and is set by the shell; **do not set it
on a NAS or container deployment**, which uses the ADR-0010 passphrase and
ADR-0015 device pairing instead. The token authenticates the shell, not the
owner: a library with a passphrase stays locked until it is actually unlocked,
unlike a paired device token, because the local token is minted with no approval
ceremony.

**Source operations:** the deployment switch and each serving instance's library
write permission gate reviewed file and directory Copy, Rename, Move, Replace, Trash
and Undo. Two source workers run byte copies outside HTTP handlers. Back up
`.cairndex/source-operations/` with library source files; private snapshots contain
the journal, not these retained bytes. No automatic purge is provided. Source
operations require atomic no-replace relocation. Directory reviews have bounded entry and metadata limits. Provider/NAS
qualification remains incomplete. See [source operations](file-operations.md).

Advanced HLS knobs (rarely changed): `CAIRNDEX_TRANSCODE_SEGMENT_WAIT`
(default `20`, seconds to wait for a segment the encoder is producing before
restarting ffmpeg), `CAIRNDEX_TRANSCODE_AHEAD_WINDOW` (default `5`, segments a
request may lead the encoder before a far-seek restart and the maximum lookahead
one bounded ffmpeg run produces), and
`CAIRNDEX_TRANSCODE_KEYFRAME_TIMEOUT` (default `60`, ffprobe deadline for the
one-time remux keyframe scan).

**Transcode scratch directory.** Interactive HLS sessions write fMP4 segments
under `{CAIRNDEX_DATA_DIR}/transcode/{session_id}/` — server-local, ephemeral
runtime state, **never** inside a library package (ADR-0014). It is created on
demand, reaped when sessions end/idle/shut down, and safe to wipe between runs;
no backup is needed. Each ffmpeg process produces only one bounded lookahead
window rather than racing to copy the whole source. A session retains fragments
it has already produced for backward seeks, so size the directory for roughly
`MAX_SESSIONS × the video length actually watched or scrubbed` (a whole movie's
worth remains the worst case after traversing the whole timeline); on the `/data` volume a
few GB of headroom is ample for the default 2-session bound.

Compose-only host knobs (`.env`): `CAIRNDEX_BIND_ADDR` (default `127.0.0.1`),
`CAIRNDEX_PORT` (default `8000`), and `CAIRNDEX_LIBRARY_PATH` (host Cairndex library
root mounted at `/libraries/main`). One `.env` serves both stacks; the dev stack
reads the separate `CAIRNDEX_DEV_*` keys, so configuring one never silently
reconfigures the other.

**A schema note, since the entrypoint no longer implies otherwise.** Cairndex has
no migration chain in use. The registry DB is bootstrapped by `create_all` on
first open, and each library's schema is created with its `.cairndex` package and
patched additively on every open (`persistence.engine.ensure_content_indexes`
adds missing columns, tables, and indexes; `ensure_search_schema` rebuilds the
derived FTS cache atomically when its version, columns or triggers change,
using bounded rowid batches). Nothing needs to be run before or after
an upgrade — starting the new image is the whole procedure. The entrypoint used
to call `alembic upgrade head`, which had quietly become a no-op that still
printed a line claiming migrations were applied.

That is a forward-upgrade statement, not a blanket downgrade promise. Before an
update, take and copy off-box the registry and every library backup described
below, record the image tag you are leaving, and read the target version's
compatibility notes. If the candidate fails, stop it. Start the older image only
when the changelog explicitly says the schema remains backward-compatible;
otherwise restore the pre-upgrade database set first. Never run two image
versions against one library to test a rollback — the one-owner rule still
applies.

### Private serving instances

Clients can use one central server. Independent servers require separate private
data directories. Never share a working database or clone one to create another
author. Portable history can be delivered by a provider, but provider/NAS delivery
and metadata publication require separate qualification.

Release drains current work and closes the private binding. Reopen resumes local
serving. A browser disconnect does not release a server. The old shared-folder
lease, takeover and portable SQLite journal workflow are unsupported.

### Libraries that span more than one filesystem

A library root can contain a mount point — a NAS share or external drive mounted
at a subdirectory, or a bind mount in a container. That is supported, with two
operational consequences worth knowing before you plan storage.

**Moving a file across that boundary is a copy.** The rename a same-filesystem
move uses cannot cross it, so Cairndex falls back to copy-then-delete: the copy
lands under a hidden `.cairndex-xdev-…` name beside its destination, is flushed,
committed with an atomic rename, and only then is the original removed. So a
cross-boundary move takes as long as the bytes take and **needs room for a second
copy of the file while it runs** — a same-filesystem move needs neither. Moves are
still synchronous, so a very large one occupies its request for the duration.

**An interrupted one leaves a duplicate, never a hole.** Because the original is
removed last, every crash leaves the file readable at one path or both. If the
process dies in the window where both exist, the next library open finishes the
bookkeeping and *reports* the leftover original rather than deleting it —
automatic recovery does not destroy original media. You will have two copies until
you remove one, which is the deliberate trade. A crash earlier in the copy leaves
an inert hidden `.cairndex-xdev-…` entry beside the destination, which is safe to
delete.

Both also apply to the trash: `.cairndex/trash/` lives in the library package, so
deleting a file that sits on a *different* mount from the package is a copy too.

### Backups

Use **Manage libraries → Access and backups** for private snapshots and reviewed
recovery. Set `CAIRNDEX_PRIVATE_BACKUP_DIR` to place snapshots on separate private
storage. The default is a sibling of the server data directory with a `-backups`
suffix. See [private recovery](replica-recovery.md).

Back up source media and immutable `.cairndex/` history separately. Preserve the
server registry and private access settings as protected administrative state.
Use a stopped-server copy or a coherent SQLite backup for the registry. Never copy
a live working database in place. Received drafts and unpublished edits require a
private snapshot; text still held in a browser is not included.

### Remote access and security

The repository-root production compose binds to `127.0.0.1` by default;
`deploy/docker-compose.yml` binds to `0.0.0.0` for private LAN access. Restrict
that address to the intended interface. Do **not** expose either deployment directly
to the public internet. For remote access, reach it over a private network or
Tailscale, or front it with a reverse proxy that adds authentication.

An **optional per-library owner passphrase lock** (ADR-0010) is available as a
lightweight guardrail. Each library independently chooses no lock or a passphrase;
configure it in **Manage libraries → Access and backups**. For local
administration, stop the server before this command and restart afterwards:

```bash
uv run python -m cairndex.devtools.set_passphrase --library-root /path/to/library
# remove it later with --clear
```

Only a PBKDF2 hash is stored in this server's private access settings; unlocking is a
server-side session bound to an opaque HTTP-only cookie and scoped to that one
library (unlocking one protected library never unlocks another). Sessions are
in-memory, so a restart re-locks everything. Setting, replacing or removing a passphrase
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

The release build is **ad-hoc signed** — not Developer ID signed, not
notarized. That is the supported model:

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

#### `signingIdentity: "-"` is load-bearing — do not remove it

Ad-hoc signing is **not** something the toolchain supplies for free, and
believing otherwise shipped a broken bundle for several milestones. Two
different things are involved:

- the **arm64 linker** ad-hoc signs each Mach-O at link time, which is why
  individual binaries report `flags=0x20002(adhoc,linker-signed)`;
- the **bundle** must be sealed separately, producing
  `Contents/_CodeSignature/CodeResources`. Tauri does this only when
  `bundle.macOS.signingIdentity` is set, and `"-"` is the ad-hoc identity.

Without it, `Cairndex.app` has a signed executable and no resource seal, which
is *invalid* rather than unsigned:

```text
Cairndex.app: code has no resources but signature indicates they must be present
```

An invalid signature fails harder than an absent one, and it is invisible
locally because Gatekeeper only assesses **quarantined** apps — every
locally-built copy skips the check. Verify with:

```bash
codesign --verify --strict src-tauri/target/release/bundle/macos/Cairndex.app
# → valid on disk / satisfies its Designated Requirement
```

Tauri signs without `--deep`, so the nested notarized ffmpeg/ffprobe keep their
own Developer ID signatures rather than being flattened to ad-hoc. See
[ADR-0019](adr/0019-open-source-distribution-model.md) §4.

#### Checking what a downloader will actually see

A locally-built app carries `com.apple.provenance` but not
`com.apple.quarantine`, so it opens with no dialog and proves nothing about the
download path. Reproduce that path without publishing anything:

```bash
cp -R src-tauri/target/release/bundle/macos/Cairndex.app /tmp/
xattr -w com.apple.quarantine "0081;$(printf %x $(date +%s));Safari;$(uuidgen)" \
  /tmp/Cairndex.app
spctl -a -vv -t exec /tmp/Cairndex.app
```

`rejected` is the correct, expected result for an unnotarized app — that is the
state the README's **Open Anyway** steps clear. Any message about *resources*
or a malformed signature is a packaging bug, not the Gatekeeper prompt.

### Installing and updating your local build

**First install.** Open the DMG and drag Cairndex to Applications, or copy the
`.app` directly:

```bash
cp -R apps/desktop/src-tauri/target/release/bundle/macos/Cairndex.app /Applications/
```

**Updating after a rebuild — read this one.** `npm run tauri build` writes into
`target/release/bundle/`. It does **not** touch `/Applications`. Nothing warns you
that the installed copy is now older than the code you just built, and the app
shows no version anywhere, so a stale install looks identical to a fresh one. This
has already cost one debugging session: a fix was reported as "not working" while
the copy under test predated it by 40 minutes.

```bash
cd apps/desktop
npm run tauri build

# Quit the running app first — replacing a running bundle leaves it in a
# half-updated state until relaunch.
osascript -e 'quit app "Cairndex"' 2>/dev/null || true

rm -rf /Applications/Cairndex.app
cp -R src-tauri/target/release/bundle/macos/Cairndex.app /Applications/
open /Applications/Cairndex.app
```

**When in doubt, rebuild and reinstall.** It takes under a minute, and it is more
reliable than trying to determine what you are running. There is no version string
in the UI, so a stale install looks exactly like a current one.

If you do want to check, be precise about what the check proves:

```bash
diff -q \
  /Applications/Cairndex.app/Contents/MacOS/cairndex-desktop \
  apps/desktop/src-tauri/target/release/bundle/macos/Cairndex.app/Contents/MacOS/cairndex-desktop
```

A match means only that the installed copy equals **the last artifact you built**.
It says nothing about whether that artifact reflects your current source — if the
build predates your latest edits, both sides are equally stale and this reports a
match. Confirming "the installed app matches the last build" and concluding "the
installed app has my fix" is a real trap; it has already misled a debugging session
here. Only a fresh `npm run tauri build` immediately before the copy makes the
match meaningful.

Do **not** compare modification times instead: `cp -R` stamps the copy with the
time it was copied, not built, so timestamps legitimately differ even when the
install is current.

**After every rebuild, re-check `cairndex://` scheme ownership** — each build
recreates and re-registers the build-directory bundle, so the installed copy may
stop being the one that handles links. See the section below.

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
  src-tauri/target/release/bundle/dmg/Cairndex_0.2.0_aarch64.dmg
# → rejected
# → source=no usable signature
```

`rejected` here means "validly signed, but not by an identity Apple vouches
for". It is a different and much better failure than the malformed-bundle case
above — see `signingIdentity: "-"` is load-bearing.

That `rejected` is expected and harmless on the machine that built it; it is what
another Mac's Gatekeeper reports before the owner approves it once.

One more consequence of the ad-hoc model: **an ad-hoc signature changes on every
rebuild.** Some macOS privacy grants are keyed to the code signature rather than
the bundle identifier, so a rebuilt app may occasionally re-prompt for a
permission it was already granted — for Cairndex that is most likely the
local-network prompt the shell already triggers when reaching a LAN server.
Re-approving is expected under this model, not a sign of misconfiguration; a
stable Developer ID signature is what removes it.

Mounted-SMB Copy/Replace/Undo requests the saved SMB login through the packaged
backend. Ad-hoc builds use a code hash as their designated requirement, so saved
Keychain grants may not cover a rebuilt executable. Local source builders can
[configure a persistent sidecar certificate](development.md#local-server-sidecar-appsserverpackaging)
with `uv run python packaging/macos_signing.py create-local` from `apps/server`.
Both build variants then retain the same certificate and `dev.cairndex.sidecar`
identifier. The first operation with the new signer can require **Always Allow**;
subsequent builds satisfy that grant while the certificate is retained. This local
identity changes neither system trust nor Gatekeeper/notarization requirements.
It is not automatically created by a build or distributed as a signing key.
An unanswered request times out after 20 seconds and preserves recoverable
intent for an explicit retry; background recovery does not prompt.

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

The build reads its release signing configuration from the environment.
Without these variables or an opted-in local sidecar certificate, it uses ad-hoc
signatures and no notarization. A local sidecar certificate preserves Keychain
access but does not qualify a public release. The Developer ID path below still
requires verification of the complete bundled dependency set and notarization.

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
DMG=src-tauri/target/release/bundle/dmg/Cairndex_0.2.0_aarch64.dmg
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
- The `dev.cairndex.desktop` bundle identifier is owner-specified and must match the
  identifier registered under the team.
- Auto-update is **deferred**, not part of this pipeline (see
  [plan 3 §3](plans/03-macos-desktop-app.md)). The public repository removes the
  old token-distribution blocker, but updater signing, `latest.json`, rollback,
  and update UX remain separate post-release scope.

### Cutting a release (plan 3 D7)

`.github/workflows/release.yml` runs on a `v*` tag, or on manual dispatch with a
tag as input. It builds **Apple Silicon only**, then attaches the DMG to a
**draft** release — publishing stays a human decision.

The release body is `.github/release-preamble.md` (install and licensing, which
do not change between releases) followed by that version's own section of
`CHANGELOG.md`. GitHub's generated notes are **off**: they list merged pull
requests, which describes a release only when every change arrived as one. For
v0.1.1 most changes were merged directly onto `main` after the repository was
recreated, so the generated notes named a single PR for a release carrying a
feature, eleven fixes and a breaking change — and had to be rewritten by hand.

The build job fetches the pinned ffmpeg, builds and smoke-tests the sidecar,
builds the app and DMG, and refuses to continue on a bad bundle signature or a
binary of the wrong architecture. It also verifies the app bundle and then
mounts the DMG read-only to prove both contain the MIT license, third-party
notice, GPLv3 text, and LGPLv3 text. The draft carries the `.dmg`, its
`.sha256`, an SPDX JSON inventory of the app payload inside it, and the same
four license/notice files beside it. GitHub build-provenance and SBOM
attestations bind the downloadable DMG to that workflow run and SBOM.

#### The procedure

**1. Before tagging.** The tag is the input to everything below, and a tag that
is wrong is more annoying to undo than to get right.

- Install the privacy hooks with `just install-privacy-hooks`, maintain the
  untracked owner-literal profile, and run `just privacy-history HEAD`. A tag
  publishes every object in its reachable history; a range-only diff is not
  sufficient after repository recreation or a rewrite. Do not tag if the gate
  or the required PR privacy check is missing or failing.
- `VERSION` is the release version. Bump it and the matching Python, npm,
  Cargo, lockfile, and Tauri package versions in the same commit. Run
  `python3 infra/release_version.py`; it names every stale source. The release
  workflow repeats that check against the tag on a Linux runner **before** it
  starts the macOS build, so a `v0.2.0` tag can no longer silently produce a
  mismatched DMG or spend macOS minutes before failing.
- `CHANGELOG.md` — move `Unreleased` entries under the new version. **This is
  enforced**: the release body is that section, extracted by
  `infra/release_notes.py`, and the job fails if `## [<version>]` is missing
  rather than publishing a release with no notes. This check also runs in the
  Linux preflight before the macOS build.
- Gates green on `main` (`AGENTS.md`), since the tag is what gets built.

**2. Tag and push.** Annotated, so the tag carries its own description:

```bash
git tag -a v0.2.0 -m "v0.2.0 — <summary>"
git push origin v0.2.0
```

The push triggers the workflow. Do **not** also dispatch it manually — that
would build the same tag twice, and macOS minutes are the expensive kind (see
the cost note below). `workflow_dispatch` is for re-running a tag that already
exists, after fixing a workflow-level failure. Dispatch from that tag as well as
entering it as the input (`gh workflow run Release --ref v0.2.0 -f
tag=v0.2.0`); preflight rejects a mismatch so build provenance cannot name the
default branch while the checkout actually builds a tag.

**3. Watch the run.**

```bash
gh run list --workflow=Release --limit 1
gh run watch <run-id> --exit-status
```

**4. Review the draft** at `gh release view v0.2.0 --web`. The Apple Silicon
DMG, its `.sha256`, and its `.app.spdx.json` should be attached — one of each,
since Intel was dropped from the matrix after the first run (2026-07-23) —
together with `LICENSE`, `THIRD-PARTY-NOTICES.md`, `GPL-3.0.txt`, and
`LGPL-3.0.txt`. Restoring Intel means uncommenting the matrix entry in
`release.yml` and this step then expects two sets. Download the DMG and actually
open it — the workflow proves the bundle is signed, correctly architected, and
carries its notices, but only a real download carries `com.apple.quarantine`,
which is the one thing local builds never reproduce.

**5. Publish** when satisfied:

```bash
gh release edit v0.2.0 --draft=false
```

#### Backing out

A draft release is not visible to anyone, so a bad build costs nothing but
minutes — delete the draft and the tag, fix, and re-tag:

```bash
gh release delete v0.2.0 --yes --cleanup-tag   # removes the draft and the tag
# or, if no release object exists yet:
git push origin --delete v0.2.0 && git tag -d v0.2.0
```

Once a release is **published**, do not re-point the tag. People may already
have the artifacts, and a moved tag makes their checksums lie. Ship a new
version instead.

#### Cost

The repository is public (since 2026-07-23), so the standard runners this
workflow uses are free and unmetered. It was not always so: while it was
private, macOS billed at **10× the Linux rate** for a job doing a full release
build (Rust `--release`, PyInstaller, DMG). If the repository ever goes private
again, re-running a release to fix a typo in the notes becomes an expensive way
to do it — edit the draft instead.

#### Distribution actually works now

[ADR-0019](adr/0019-open-source-distribution-model.md)'s premise is publishing
prebuilt binaries to people who are not the author, and that premise only came
true when the repository went public on 2026-07-23. Before then the pipeline
could be exercised end to end while the distribution goal went unmet, because a
release is visible only to people who can see the repository.

#### Why there is no Intel artifact

Intel was dropped after the v0.1.0 run (owner, 2026-07-23). It is not needed,
and it was the expensive half: on that run the Intel runner took 98s to freeze
the sidecar against arm64's 24s — roughly 4× slower at every compile-bound step,
on minutes billed at 10×.

Dropping it removed one matrix entry and nothing else. `macos-x86_64` is still
pinned in `ffmpeg-manifest.json`, the architecture checks still cover it, and
the local Intel build below still produces a working app. Restoring the artifact
means uncommenting the matrix entry in `release.yml`, which keeps the five
values it needs — including the `macos-15-intel` runner label, verified usable
on 2026-07-23. The old free `macos-13` Intel image is retired, so that label is
the only Intel option.

**Any architecture needs its own native job; `--target` alone is not enough.**
The Rust half cross-compiles fine, but the sidecar is a PyInstaller bundle, and
PyInstaller freezes *the interpreter that runs it* — it has no cross-compile
mode. That is why the matrix pins `uv sync --python
cpython-3.12-macos-<arch>-none` rather than leaving the interpreter to the
runner's default. `--platform` on `build_sidecar.py` selects which checksum pin
to verify against; it cannot change what got frozen, and the script refuses a
bundle whose architecture disagrees with it.

#### Building the other architecture locally

Useful for reproducing a release-job failure without pushing a tag. On an Apple
Silicon Mac with Rosetta, an Intel build is:

```bash
rustup target add x86_64-apple-darwin
uv python install cpython-3.12-macos-x86_64-none

cd apps/server
uv run python packaging/fetch_ffmpeg.py --platform macos-x86_64
UV_PROJECT_ENVIRONMENT=.venv-x86_64 uv sync --frozen \
  --python cpython-3.12-macos-x86_64-none
.venv-x86_64/bin/python packaging/build_sidecar.py --platform macos-x86_64

cd ../desktop
npm run tauri build -- --target x86_64-apple-darwin --bundles app,dmg
```

The sidecar build must run from the x86_64 environment's own interpreter —
`uv run` would pick the default arm64 one and the architecture check would stop
the build. Fetched binaries are stored per platform under
`packaging/vendor/ffmpeg/<platform>/`, so both architectures coexist instead of
overwriting each other. Note that `packaging/dist/cairndex-sidecar` is a single
path that `tauri.conf.json` stages as a resource, so building both architectures
on one machine means rebuilding the sidecar between them.

### Linux and Windows

Out of scope for v1 but kept cheap by the cross-platform rules in plan 3 §2.1.
Linux packaging would be AppImage/deb with no notarization concept; Windows would
want an Authenticode certificate on the same env-gated pattern.

## Health check

`GET /api/v1/health` returns the liveness state, API capabilities, synchronized
package version, and (for release artifacts) the public source commit. The same
version is OpenAPI's `info.version` and appears under **Settings → About**. This
endpoint backs the image's Docker `HEALTHCHECK` and any NAS container-manager
liveness probe. No authentication is required, so `build_commit` accepts only a
hexadecimal Git SHA and never reflects arbitrary environment text.

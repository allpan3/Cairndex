# Deploying Cairndex to a server

Everything a NAS or home server needs to run Cairndex is
[`docker-compose.yml`](docker-compose.yml) — one file. No checkout of this
repository, no build toolchain, no source on the box: the image is pulled from
GitHub Container Registry.

Every setting has a working default written into that file, so it runs as-is
once you edit the library path. That is deliberate: a NAS Docker UI that takes
a pasted or uploaded compose file has nowhere to put an `.env`, and a compose
file that only works beside one is a compose file that only works from a shell.

For the reasoning behind any of it — the hardening, private storage,
backups, remote access — see [`docs/deployment.md`](../docs/deployment.md). This
page is the runbook.

> Optional per-library passphrase sessions and paired device tokens provide a
> private-network access guard; unlocked libraries remain anonymous. The compose
> file binds all host interfaces by default, so restrict it to the intended LAN.
> Direct public exposure is unsupported. Use Tailscale or a VPN for remote access.

## Install — through your NAS's Docker UI

Synology, UGREEN, QNAP and TrueNAS all have a **Project** / **Stack** /
**Compose** section that takes a compose file and then manages the result like
any other container, with logs and stats in the UI. That is the path to use if
you would rather not administer this from a shell.

1. Make a folder for it on the NAS, e.g. `docker/cairndex`.
2. Create a **Project** (UGREEN and Synology call it that; QNAP calls it an
   Application, TrueNAS a Custom App with YAML) pointed at that folder, and
   paste in [`docker-compose.yml`](docker-compose.yml).
3. Edit the marked library path and restrict the bind address to your private network.
4. Start it.

The image is public, so no registry login is needed. It will **not** appear in
the Docker app's image-search tab — that tab searches Docker Hub, and this image
is on GitHub Container Registry. Pulling it by its full name in a compose file
works regardless; the search index and the pull are unrelated.

## Install — from a shell

```bash
mkdir -p /volume1/docker/cairndex && cd /volume1/docker/cairndex
```

```bash
curl -O https://raw.githubusercontent.com/allpan3/Cairndex/main/deploy/docker-compose.yml
```

Edit the library path in it, or put an `.env` beside it — see
[`.env.example`](.env.example), which is optional and overrides the file's
defaults.

```bash
docker compose up -d
```

## First run

Open `http://<nas>:8000`, add a library in the app's library manager, and run
**Update** to scan it.

**The path you type is the one *inside* the container.** If you mounted
`/volume1/media` at `/libraries/main`, then the folder you think of as
`/volume1/media/films` is `/libraries/main/films` to the app. Type the host path
and you get "root path does not exist" — accurate, from where the app is
standing.

## Mounts and libraries

A mount is a **share**. A library is a folder Cairndex indexes. They are not the
same thing, and the compose file lists the first, not the second.

**One mount holds as many libraries as you like.** With `/volume1/media` mounted,
`/libraries/main/films` and `/libraries/main/photos` can each be a separate
library, added whenever you feel like it, live — no compose change, no restart.
Create requires a root without existing Cairndex metadata and leaves any source
files in place. Open admits an existing compatible format-three package.

**You edit compose only when files live somewhere the container cannot see** —
a different volume or share. Then you add a sibling mount:

```yaml
- "/volume1/media:/libraries/main:rw"
- "/volume2/archive:/libraries/archive:rw"
```

**Add mounts beside each other; never re-path one that is in use.** The registry
records each library under the path the container saw when it was registered, so
moving a mount orphans everything inside it and you have to register it all
again. That is why mounts hang under `/libraries` rather than being `/libraries`
— starting with one share and adding a second later costs nothing.

## Permissions — pick one of two approaches

By default the container runs as uid/gid **10001**, a user created in the image.
On Linux that id is literal on the host too, so every path you mount has to be
writable by it.

### Simplest: run as yourself

Set `user:` in the compose file to your own id and **change no ownership at
all**. Find it on the NAS with:

```bash
id -u && id -g
```

```yaml
    user: "1000:1000"
```

The app then writes as you, into directories you already own. Files Cairndex
creates stay yours, so a host-side backup can read them — the whole ownership
problem below simply does not arise.

The app writes private state to `/data`, snapshots to `/backups`, temporary
files to `/tmp` and immutable metadata to the library package; `infra/docker/smoke.sh` tests the image under
an arbitrary uid so that stays true. Use writable bind mounts for both `/data` and `/backups` when running as your
own uid. New named volumes inherit the image's uid 10001 and may deny another uid.

### Or: grant uid 10001 access

Leave `user:` alone and grant that id write access to private data, separate
backup storage and the library metadata package:

```bash
sudo mkdir -p /volume1/docker/cairndex/data /volume1/docker/cairndex/backups
sudo chown -R 10001:10001 /volume1/docker/cairndex/data /volume1/docker/cairndex/backups
```

```bash
sudo setfacl -m u:10001:rwx /path/to/library/root
```

The first is recursive because those private directories belong to Cairndex alone. The
second is **not recursive on purpose**: Cairndex only needs to create
`.cairndex/` in the library root, and everything it writes goes inside that.
Your media files just need to stay readable. Do not `chown -R` a media share —
it rewrites ownership of every file you have and can lock your own account out.

If `setfacl` is unavailable:

```bash
sudo chgrp 10001 /path/to/library/root && sudo chmod g+rwx /path/to/library/root
```

With this approach, files Cairndex creates are owned by `10001:10001` and the
private administrative state has restricted modes, so your own account may not be able to read all
of them. That matters for host-side backups; see [Backups](#backups).

**If the container exits immediately, read the log first.** A startup preflight
refuses to run when `/data` is not writable by uid 10001 and says so in one
line. That is the check working: without it, the same misconfiguration surfaces
much later as an opaque SQLite "unable to open database file" from whichever
request happened to touch the registry first.

```bash
docker compose logs app
```

## Updating

Before updating, create and verify private snapshots for each library through
**Manage libraries → Access and backups**, and protect source media, immutable
history, retained source versions and administrative settings separately. Take
a hot registry copy and copy the complete backup volume to private off-box storage:

```bash
docker compose exec app /app/infra/backup.sh /data/registry.db /backups
docker compose cp app:/backups ./backups
docker compose pull && docker compose up -d
```

Private stores use validated schema upgrades. Read the target changelog before
a downgrade; if backward compatibility is not explicit, stop and restore an
independently verified pre-upgrade set. No automatic old-library conversion exists.

Pin `CAIRNDEX_IMAGE_TAG` in `.env` if you would rather updates be a version you
choose than whatever `:latest` points at today.

## Stopping

```bash
docker compose down
```

A clean shutdown drains admitted work and closes private databases and process
locks. The compose file allows 30 seconds. A forced exit can leave operations
interrupted; inspect retained review/recovery tasks and retry explicitly. It
does not establish power-loss safety. A client disconnect does not Release a library.

## Backups

Back up source files, immutable `.cairndex/` history and retained
`.cairndex/source-operations/` versions separately. Private snapshots capture
received drafts, unpublished metadata and journals; administrative access settings,
device credentials, server configuration and unreceived browser text are separate.
The compose file gives snapshots their own `cairndex-backups` volume at `/backups`.
Keep a protected copy on independent storage.

When adopting this example, retain the existing data volume and any configured
backup mount/path and its contents. An empty new backup volume does not contain
previous managed snapshots. Verify a copied snapshot in an isolated deployment
before switching an established snapshot location.

Use the verified [private recovery procedure](../docs/replica-recovery.md) for
portable stores. Registry copies use `backup.sh`; its guarded restore helper
requires every process using that registry to be stopped:

```bash
docker compose down
docker compose run --rm --no-deps \
  -v "$PWD/backups:/restore:ro" \
  --entrypoint /app/infra/restore.sh app \
  --stopped /restore/<registry-backup> /data/registry.db
docker compose up -d
```

The helper refuses WAL sidecars, verifies a temporary copy, atomically installs it
and retains the previous file for rollback. It rejects legacy `library.db`
maintenance; replacing a portable working store directly is unsupported.

## When something is refused

These refusals identify configuration or lifecycle prerequisites:

- **A private store is already in use.** Each server needs its own private data
  directory. Stop the other process using this instance's private store; do not
  share or clone working SQLite databases.
- **Library metadata is unwritable.** Keep source media protected if needed,
  while permitting immutable metadata publication under `.cairndex/`.
- **Library is Released.** Reopen it deliberately before normal serving.
- **The preflight message about an unwritable `/data`.** See
  [Permissions](#permissions--read-this-before-the-first-run).

## Running an unreleased version

The published tags come from version tags and from deliberate manual runs of the
`Publish image` workflow — never automatically from `main`. To run something
that has not been published, build from a checkout instead, with the compose
file at the repository root:

```bash
docker compose -f docker-compose.prod.yml up --build -d
```

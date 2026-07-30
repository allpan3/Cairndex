# Deploying Cairndex to a server

Everything a NAS or home server needs to run Cairndex is
[`docker-compose.yml`](docker-compose.yml) — one file. No checkout of this
repository, no build toolchain, no source on the box: the image is pulled from
GitHub Container Registry.

Every setting has a working default written into that file, so it runs as-is
once you edit the library path. That is deliberate: a NAS Docker UI that takes
a pasted or uploaded compose file has nowhere to put an `.env`, and a compose
file that only works beside one is a compose file that only works from a shell.

For the reasoning behind any of it — the hardening, the ownership lease,
backups, remote access — see [`docs/deployment.md`](../docs/deployment.md). This
page is the runbook.

> **No authentication yet** (`AGENTS.md` §12). Anyone who can reach the port can
> use it. The compose file binds your LAN, which is the intended reach; do not
> port-forward it. For access from outside, use Tailscale or a VPN.

## Install — through your NAS's Docker UI

Synology, UGREEN, QNAP and TrueNAS all have a **Project** / **Stack** /
**Compose** section that takes a compose file and then manages the result like
any other container, with logs and stats in the UI. That is the path to use if
you would rather not administer this from a shell.

1. Make a folder for it on the NAS, e.g. `docker/cairndex`.
2. Create a **Project** (UGREEN and Synology call it that; QNAP calls it an
   Application, TrueNAS a Custom App with YAML) pointed at that folder, and
   paste in [`docker-compose.yml`](docker-compose.yml).
3. Edit the two lines the file marks: the library path, and the machine name.
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
Creating one even makes the folder if it is not there yet.

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

This works because the app writes only to `/data`, `/tmp` and the library
mounts, all supplied from outside; `infra/docker/smoke.sh` tests the image under
an arbitrary uid so that stays true. **One requirement: `/data` must be a bind
mount.** A named volume takes its ownership from the image — uid 10001 — and
would lock your id out of it.

### Or: grant uid 10001 access

Leave `user:` alone and give that id what it needs. Two grants, and note what
each one is *not*:

```bash
sudo mkdir -p /volume1/docker/cairndex/data && sudo chown -R 10001:10001 /volume1/docker/cairndex/data
```

```bash
sudo setfacl -m u:10001:rwx /path/to/library/root
```

The first is recursive because that directory belongs to Cairndex alone. The
second is **not recursive on purpose**: Cairndex only needs to create
`.cairndex/` in the library root, and everything it writes goes inside that.
Your media files just need to stay readable. Do not `chown -R` a media share —
it rewrites ownership of every file you have and can lock your own account out.

If `setfacl` is unavailable:

```bash
sudo chgrp 10001 /path/to/library/root && sudo chmod g+rwx /path/to/library/root
```

With this approach, files Cairndex creates are owned by `10001:10001` and the
ownership lease is mode `0600`, so your own account may not be able to read all
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

```bash
docker compose pull && docker compose up -d
```

There is no migration step. The registry database is created on first open and
each library's schema is patched additively when that library opens, so
upgrading is just starting the new image. Downgrading is likewise just starting
an older one, within the compatibility notes in `CHANGELOG.md`.

Pin `CAIRNDEX_IMAGE_TAG` in `.env` if you would rather updates be a version you
choose than whatever `:latest` points at today.

## Stopping

```bash
docker compose down
```

Prefer this to killing the container. A clean shutdown releases each library's
ownership lease and checkpoints its WAL back into `library.db`. A `SIGKILL`
part-way through strands the lease until it ages out (five minutes), and during
that window nothing else will open the library — including your desktop app —
without a confirmed takeover. The compose file allows 30s for this, above
Docker's 10s default, which matters for a large or network-mounted library.

## Backups

Back up:

- each library's `<library root>/.cairndex/library.db`;
- the `cairndex-data` volume, which holds the server-local `registry.db`;
- `<library root>/.cairndex/trash/` **if you use write mode** — it holds real
  deleted files that have not been permanently removed, and it is not derived
  from anything.

`.cairndex/cache/` is regenerable and can be skipped.

Because those files are owned by uid 10001, a backup job running as your own
account may be denied. Run it with enough privilege, share a group with 10001,
or read the package through a container.

## When something is refused

Two refusals look like failures and are not:

- **"This library is open on another server."** A library may be open on exactly
  one server at a time (ADR-0018). Your desktop app counts. Close it, or point
  the server at a different library.
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

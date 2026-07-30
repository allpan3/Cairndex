# Deploying Cairndex to a server

Everything a NAS or home server needs to run Cairndex: a compose file and an
env file. No checkout of this repository, no build toolchain, no source on the
box — the image is pulled from GitHub Container Registry.

For the reasoning behind any of it — the hardening, the ownership lease, backups,
remote access — see [`docs/deployment.md`](../docs/deployment.md). This page is
the runbook.

> **No authentication yet** (`AGENTS.md` §12). Do not put Cairndex on the public
> internet. A LAN, a VPN, or Tailscale is the intended reach.

## Install

```bash
mkdir -p /volume1/docker/cairndex && cd /volume1/docker/cairndex
```

```bash
curl -O https://raw.githubusercontent.com/allpan3/Cairndex/main/deploy/docker-compose.yml
```

```bash
curl -o .env https://raw.githubusercontent.com/allpan3/Cairndex/main/deploy/.env.example
```

Edit `.env`. `MEDIA_HOST_PATH` is the only required value; compose refuses to
start without it rather than inventing an empty `./media`.

```bash
docker compose up -d
```

Then open the bound address (`http://<host>:8000` by default), create or
register the library at `/storage/media` in the app's library manager, and run
**Update** to scan it.

## Permissions — read this before the first run

The container runs as uid/gid **10001**, not root. On Linux that id is literal
on the host as well, in both directions:

- Cairndex must be able to write `<library root>/.cairndex/`, where it keeps
  each library's portable package (`manifest.json`, `library.db`, `cache/`).
  Your media files themselves are only ever read.
- Files it creates there end up **owned by `10001:10001` on the host**, so your
  own account may not be able to read all of them — the ownership lease is mode
  `0600`. That matters for host-side backups; see [Backups](#backups).

Grant it whichever way suits the box:

```bash
sudo setfacl -R -m u:10001:rwx /path/to/library
```

```bash
sudo chown -R 10001:10001 /path/to/library/.cairndex
```

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

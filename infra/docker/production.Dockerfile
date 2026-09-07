# Cairndex production image — single hardened container (AGENTS.md §12).
#
# Ships both halves of the app: a multi-stage build compiles the frontend and
# installs the backend, and the slim runtime serves the built SPA from FastAPI
# (CAIRNDEX_STATIC_DIR) behind /api. Runs as a non-root user; ffmpeg/ffprobe
# are present for scanning, thumbnails, and subtitle conversion.
#
# Build context is the REPO ROOT (both apps/* are needed):
#   docker build -f infra/docker/production.Dockerfile -t cairndex:latest .
# See docs/deployment.md and docker-compose.prod.yml.

# --- Stage 1: build the frontend into static assets ---------------------------
FROM node:22-bookworm-slim AS web
WORKDIR /web
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci
COPY apps/web/ ./
# Same-origin in production: the SPA calls /api on its own host, so no build-time
# API base URL is needed (the dev Vite proxy is not used here).
RUN npm run build

# --- Stage 2: install the backend + its locked dependencies -------------------
FROM python:3.14-slim AS server
COPY --from=ghcr.io/astral-sh/uv:0.11.23 /uv /uvx /bin/
ENV UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1
WORKDIR /app
# Dependency layer cached on pyproject/lock; project installed after source copy.
COPY apps/server/pyproject.toml apps/server/uv.lock apps/server/.python-version ./
RUN uv sync --frozen --no-install-project --no-dev
COPY apps/server/ ./
RUN uv sync --frozen --no-dev

# --- Stage 3: minimal hardened runtime ----------------------------------------
FROM python:3.14-slim AS runtime
ARG CAIRNDEX_BUILD_COMMIT=""

# ffmpeg/ffprobe: media probing (Phase 2), thumbnails (Phase 2), and subtitle
# conversion (Phase 6) shell out to them via PATH. Curl is for the healthcheck.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg curl \
    && rm -rf /var/lib/apt/lists/*

# Non-root user (AGENTS.md §12). A fixed high UID/GID plays well with NAS volume
# permissions, and is the id the mounted volumes must grant write access to: /data
# always, and the library root too, since a library keeps its .cairndex/ package
# (manifest, library.db, cache) inside it. Source *media* is still never written
# outside an ADR-0013 write-mode operation — a writable mount is not write mode.
RUN groupadd --gid 10001 app \
    && useradd --uid 10001 --gid app --no-create-home --home /app app

ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    CAIRNDEX_ENVIRONMENT=production \
    CAIRNDEX_BUILD_COMMIT=$CAIRNDEX_BUILD_COMMIT \
    CAIRNDEX_STATIC_DIR=/app/web \
    CAIRNDEX_DATA_DIR=/data

WORKDIR /app
# The venv installs the project editable against /app, so the source must live
# at the same path it did during install (see stage 2). Copy only that runtime
# source rather than the build-stage workdir: lockfiles, packaging helpers, and
# dependency caches have no purpose in a published image.
COPY --from=server /opt/venv /opt/venv
COPY --from=server /app/src /app/src
COPY --from=web /web/dist /app/web
# A container image is a distribution too. Keep its project and transitive
# license notices inspectable without requiring the source checkout.
COPY LICENSE THIRD-PARTY-NOTICES.md /app/
COPY licenses/ /app/licenses/
# Operator scripts (build context is the repo root, so infra/ is available
# here even though the server stage's /app only holds apps/server). The
# entrypoint preflights the writable mounts; backup.sh is the documented backup
# tool.
COPY infra/docker/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY infra/backup.sh /app/infra/backup.sh
COPY infra/restore.sh /app/infra/restore.sh
RUN chmod +x /usr/local/bin/entrypoint.sh /app/infra/backup.sh /app/infra/restore.sh

# Writable app-data dir (SQLite DB + derived-media cache) — a mounted volume in
# production, owned by the non-root user. Kept outside any storage root.
RUN mkdir -p /data && chown -R app:app /data
VOLUME ["/data"]

# The root every library mount hangs under: /libraries/main, /libraries/archive.
# Created here rather than left to Docker so that it exists even when nothing is
# mounted — which is what lets the entrypoint tell "you mounted nothing" apart
# from "your mount is not writable". It stays empty and read-only in the image;
# only its children are ever mounts.
RUN mkdir -p /libraries

USER app
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD curl -fsS http://localhost:8000/api/v1/health || exit 1

# No --reload in production; a single worker keeps the in-process job worker and
# SQLite writer simple (ADR-0001). Scale by process supervision, not threads.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["uvicorn", "cairndex.main:app", "--host", "0.0.0.0", "--port", "8000"]

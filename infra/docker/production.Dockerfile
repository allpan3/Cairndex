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
FROM python:3.12-slim AS server
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
FROM python:3.12-slim AS runtime

# ffmpeg/ffprobe: media probing (Phase 2), thumbnails (Phase 2), and subtitle
# conversion (Phase 6) shell out to them via PATH. Curl is for the healthcheck.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg curl \
    && rm -rf /var/lib/apt/lists/*

# Non-root user (AGENTS.md §12). A fixed high UID/GID plays well with NAS volume
# permissions; the app never needs root and the storage root is mounted ro.
RUN groupadd --gid 10001 app \
    && useradd --uid 10001 --gid app --no-create-home --home /app app

ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    CAIRNDEX_ENVIRONMENT=production \
    CAIRNDEX_STATIC_DIR=/app/web \
    CAIRNDEX_DATA_DIR=/data

WORKDIR /app
# The venv installs the project editable against /app, so the source must live
# at the same path it did during install (see stage 2).
COPY --from=server /opt/venv /opt/venv
COPY --from=server /app /app
COPY --from=web /web/dist /app/web

# Writable app-data dir (SQLite DB + derived-media cache) — a mounted volume in
# production, owned by the non-root user. Kept outside any storage root.
RUN mkdir -p /data && chown -R app:app /data
VOLUME ["/data"]

USER app
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD curl -fsS http://localhost:8000/api/v1/health || exit 1

# No --reload in production; a single worker keeps the in-process job worker and
# SQLite writer simple (ADR-0001). Scale by process supervision, not threads.
CMD ["uvicorn", "cairndex.main:app", "--host", "0.0.0.0", "--port", "8000"]

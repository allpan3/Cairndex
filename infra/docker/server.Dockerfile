# Cairndex backend — development image.
#
# Dev-oriented: runs uvicorn with --reload against the source bind-mount that
# docker-compose.yml provides. The hardened, non-root, SPA-serving production
# image is infra/docker/production.Dockerfile. Build context is apps/server
# (see docker-compose.yml).

FROM python:3.14-slim

# ffmpeg/ffprobe are not optional for a usable server: scanning probes every
# media file through ffprobe, and thumbnails, storyboards, subtitle conversion,
# and HLS remux/transcode all shell out to ffmpeg. Without them the container
# starts and then fails at the first scan, which is the first thing anyone does.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# uv provides fast, locked dependency installs. Pinned for reproducible builds.
COPY --from=ghcr.io/astral-sh/uv:0.11.23 /uv /uvx /bin/

ENV UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Install dependencies first (without the project itself) so this layer is
# cached as long as pyproject.toml / uv.lock are unchanged.
COPY pyproject.toml uv.lock .python-version ./
RUN uv sync --frozen --no-install-project

# Then copy the source and install the project itself.
COPY . .
RUN uv sync --frozen

EXPOSE 8000

# Liveness probe hits the same endpoint a NAS container manager would use.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8000/api/v1/health').getcode()==200 else 1)"

# --reload-dir src, not a bare --reload. The compose bind-mount puts the whole
# of apps/server at /app, which on a developer machine includes .venv (tens of
# thousands of files, and a second one for the x86_64 sidecar build) and var/.
# Watching those costs startup time and CPU for directories that can never
# contain a reload-worthy edit.
CMD ["uvicorn", "cairndex.main:app", "--host", "0.0.0.0", "--port", "8000", \
     "--reload", "--reload-dir", "src"]

# Cairndex backend — development image.
#
# This is a dev-oriented image (runs uvicorn with --reload and is intended to
# be used with a source bind-mount via docker-compose). The hardened,
# non-root, static-frontend-serving production image is Phase 8 work
# (docs/deployment.md). Build context is apps/server (see docker-compose.yml).

FROM python:3.12-slim

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

CMD ["uvicorn", "cairndex.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]

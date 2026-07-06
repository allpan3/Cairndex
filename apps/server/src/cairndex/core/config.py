from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# Repo-relative default app-data dir for local dev. In Docker/NAS deployments
# CAIRNDEX_DATA_DIR points at a mounted writable volume (see docs/deployment).
_DEFAULT_DATA_DIR = Path(__file__).resolve().parents[3] / "var"


class Settings(BaseSettings):
    """Application configuration, sourced from environment variables.

    See docs/deployment.md for the planned environment variables. Note that
    derived media (thumbnails/subtitles) is *not* cached here — it lives inside
    each library's portable ``.cairndex/cache/`` (ADR-0008 phase 8).
    """

    model_config = SettingsConfigDict(env_prefix="CAIRNDEX_", env_file=".env")

    app_name: str = "Cairndex"
    environment: str = "development"

    # Writable application-data directory (the server-local registry DB). Kept
    # entirely separate from any library (AGENTS.md §11/§12). Per-library content
    # and its derived cache live in each library's own ``.cairndex/`` instead.
    data_dir: Path = _DEFAULT_DATA_DIR

    # Optional explicit override for the SQLite database URL. When unset, the
    # database lives at ``{data_dir}/cairndex.db``.
    database_url: str | None = None

    # Optional explicit override for the registry database URL (ADR-0008). The
    # registry tracks registered libraries and the runtime job queue; it is
    # server-local and separate from any library's own metadata DB. When unset
    # it lives at ``{data_dir}/registry.db``.
    registry_url: str | None = None

    # Run the in-process background worker on app startup. Disabled in tests so
    # jobs are driven deterministically instead of by a polling thread.
    worker_enabled: bool = True

    # Directory of the built frontend (apps/web/dist). When set and present the
    # backend serves the SPA so a single production container ships both halves
    # (docs/deployment.md). Unset in dev — Vite serves the frontend separately.
    static_dir: Path | None = None

    # Storyboards are expensive ffmpeg-derived trickplay sheets generated only
    # by the background job. Set CAIRNDEX_STORYBOARDS=off to skip generation and
    # hide cached artifacts from manifests/endpoints
    storyboards: bool = True

    # Minimum probed duration before a video is eligible for storyboards
    storyboard_min_duration: float = 60.0

    def resolved_database_url(self) -> str:
        if self.database_url is not None:
            return self.database_url
        return f"sqlite:///{(self.data_dir / 'cairndex.db').as_posix()}"

    def resolved_registry_url(self) -> str:
        if self.registry_url is not None:
            return self.registry_url
        return f"sqlite:///{(self.data_dir / 'registry.db').as_posix()}"


@lru_cache
def get_settings() -> Settings:
    """Return a cached Settings instance.

    Settings are read from the environment once per process (the idiomatic
    FastAPI pattern). Tests that need to vary configuration should call
    ``get_settings.cache_clear()`` after mutating the environment.
    """
    return Settings()

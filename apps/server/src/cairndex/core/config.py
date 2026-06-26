from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# Repo-relative default app-data dir for local dev. In Docker/NAS deployments
# CAIRNDEX_DATA_DIR points at a mounted writable volume (see docs/deployment).
_DEFAULT_DATA_DIR = Path(__file__).resolve().parents[3] / "var"


class Settings(BaseSettings):
    """Application configuration, sourced from environment variables.

    Storage-root and media-cache paths grow here as later subsystems land —
    see docs/deployment.md for the planned environment variables.
    """

    model_config = SettingsConfigDict(env_prefix="CAIRNDEX_", env_file=".env")

    app_name: str = "Cairndex"
    environment: str = "development"

    # Writable application-data directory (SQLite DB + derived-media cache).
    # Kept entirely separate from any storage root (AGENTS.md §11/§12).
    data_dir: Path = _DEFAULT_DATA_DIR

    # Optional explicit override for the SQLite database URL. When unset, the
    # database lives at ``{data_dir}/cairndex.db``.
    database_url: str | None = None

    # Run the in-process background worker on app startup. Disabled in tests so
    # jobs are driven deterministically instead of by a polling thread.
    worker_enabled: bool = True

    # Directory of the built frontend (apps/web/dist). When set and present the
    # backend serves the SPA so a single production container ships both halves
    # (docs/deployment.md). Unset in dev — Vite serves the frontend separately.
    static_dir: Path | None = None

    def resolved_database_url(self) -> str:
        if self.database_url is not None:
            return self.database_url
        return f"sqlite:///{(self.data_dir / 'cairndex.db').as_posix()}"

    @property
    def cache_dir(self) -> Path:
        """Directory for derived media (thumbnails), kept outside any root."""
        return self.data_dir / "cache"


@lru_cache
def get_settings() -> Settings:
    """Return a cached Settings instance.

    Settings are read from the environment once per process (the idiomatic
    FastAPI pattern). Tests that need to vary configuration should call
    ``get_settings.cache_clear()`` after mutating the environment.
    """
    return Settings()

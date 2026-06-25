from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application configuration, sourced from environment variables.

    Phase 0 only needs identity fields for the health endpoint. Storage-root,
    database, and cache paths are added in Phase 1/2 once those subsystems
    exist — see docs/deployment.md for the planned environment variables.
    """

    model_config = SettingsConfigDict(env_prefix="CAIRNDEX_", env_file=".env")

    app_name: str = "Cairndex"
    environment: str = "development"


@lru_cache
def get_settings() -> Settings:
    """Return a cached Settings instance.

    Settings are read from the environment once per process (the idiomatic
    FastAPI pattern). Tests that need to vary configuration should call
    ``get_settings.cache_clear()`` after mutating the environment.
    """
    return Settings()

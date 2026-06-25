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


def get_settings() -> Settings:
    return Settings()

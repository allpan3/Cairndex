from functools import lru_cache
from pathlib import Path
from typing import Annotated
from urllib.parse import urlsplit

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

# Repo-relative default app-data dir for local dev. In Docker/NAS deployments
# CAIRNDEX_DATA_DIR points at a mounted writable volume (see docs/deployment).
_DEFAULT_DATA_DIR = Path(__file__).resolve().parents[3] / "var"
PACKAGED_DESKTOP_ORIGINS = (
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
)


class Settings(BaseSettings):
    """Application configuration, sourced from environment variables.

    See docs/deployment.md for the planned environment variables. Note that
    derived media (thumbnails/subtitles) is *not* cached here — it lives inside
    each library's portable ``.cairndex/cache/`` (ADR-0008 phase 8).
    """

    model_config = SettingsConfigDict(env_prefix="CAIRNDEX_", env_file=".env")

    app_name: str = "Cairndex"
    environment: str = "development"

    # Exact HTTP(S) origins explicitly trusted for cross-origin API access
    cors_extra_origins: Annotated[list[str], NoDecode] = Field(default_factory=list)

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
    storyboard_min_duration: float = 10.0

    # Maximum concurrent interactive HLS remux/transcode sessions (plan 1 §6.2,
    # ADR-0014). Sessions run one ffmpeg each and are bounded so a couple of
    # players can't exhaust the box; starting one beyond this returns 429.
    transcode_max_sessions: int = 2

    # Seconds without a playlist/segment fetch before an HLS session is reaped
    # (killed + its transcode dir deleted). Player close also tears sessions down.
    transcode_idle_timeout: float = 60.0

    # Bounded stat-poll wait (seconds) for a segment the encoder is producing
    # before restarting ffmpeg, and how many segments ahead of the encoder a
    # request may be before a far-seek restart (plan 1 §6.2).
    transcode_segment_wait: float = 20.0
    transcode_ahead_window: int = 5

    # ffprobe deadline for the one-time remux keyframe scan used to build a
    # keyframe-accurate copy playlist; falls back to a duration-derived playlist
    # on timeout/failure.
    transcode_keyframe_timeout: float = 60.0

    # Optional ffmpeg hardware-accelerated *decode* for transcode sessions
    # (plan 1 §6.2). One of vaapi|qsv|videotoolbox; unset/"none" uses software
    # decode. Encoding stays libx264 for portability in this MVP.
    ffmpeg_hwaccel: str | None = None

    # Parses a comma-separated environment value into validated web origins
    @field_validator("cors_extra_origins", mode="before")
    @classmethod
    def _parse_cors_extra_origins(cls, value: object) -> object:
        if not isinstance(value, str):
            return value
        origins = [origin.strip() for origin in value.split(",") if origin.strip()]
        normalized: list[str] = []
        for origin in origins:
            parsed = urlsplit(origin)
            if (
                parsed.scheme not in {"http", "https"}
                or not parsed.netloc
                or parsed.username is not None
                or parsed.password is not None
                or parsed.path not in {"", "/"}
                or parsed.query
                or parsed.fragment
            ):
                raise ValueError(f"invalid CORS origin: {origin!r}")
            normalized.append(f"{parsed.scheme}://{parsed.netloc.lower()}")
        return normalized

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

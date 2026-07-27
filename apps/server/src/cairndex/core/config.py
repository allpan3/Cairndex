from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal
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

    # Loopback owner token for the desktop local-server sidecar (ADR-0018 §5).
    # When set, every API request must present it as a bearer token. Unset for
    # an ordinary NAS/container server, which uses the ADR-0010 passphrase and
    # ADR-0015 device pairing instead. See ``auth/local_token.py``.
    local_token: str | None = None

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

    # --- Library ownership lease (ADR-0018) ---------------------------------
    # A server may serve a library only while it holds that library's
    # ``.cairndex/locks/active-owner.json`` lease.

    # Human-readable name shown to a user deciding whether to take a lease over
    # ("This library is served by …"). Defaults to the machine's hostname.
    machine_name: str | None = None

    # The URL clients can reach this server at, recorded in the lease so another
    # machine can offer "connect there instead" rather than only naming a host.
    # Only non-loopback URLs are offered as redirects (ADR-0018 §2), so leaving
    # this unset on a laptop sidecar is correct.
    advertised_url: str | None = None

    # Seconds between lease heartbeats, and how long a lease may go untouched
    # before another server may offer a (still user-confirmed) takeover. The TTL
    # is 5x the interval so a couple of missed beats — a busy box, a slow NAS —
    # never look like a dead server.
    lease_heartbeat_interval: float = 60.0
    lease_ttl: float = 300.0

    # Extra time, on top of one full heartbeat interval, that a lease is watched
    # before a confirmed takeover may proceed.
    #
    # The full interval is not configurable and never should be: a takeover
    # begins at an arbitrary point in the holder's cycle, so only after a whole
    # interval has passed is a live holder *guaranteed* to have written. This
    # margin is the slack on top of that — it covers a holder whose write has to
    # propagate through a cloud-sync engine before this machine can see it.
    # Raise it for a synced library on a slow link; the default suits a local
    # disk or a network share, where propagation is immediate.
    lease_observation_margin: float = 20.0

    # Pause between writing our lease and re-reading it to confirm our nonce
    # survived (the write-then-verify in ADR-0018 §3). Must outlast the reorder
    # window of a shared mount, not a network round trip.
    lease_verify_delay: float = 1.0

    # Run the lease heartbeat/watchdog thread on app startup. Disabled in tests
    # so lease timing is driven deterministically instead of by a background
    # thread.
    lease_heartbeat_enabled: bool = True

    # --- SQLite sync hygiene (ADR-0018 §6) ----------------------------------
    # A library in WAL mode is three files on disk, and a cloud-sync engine
    # uploads whatever it finds. Checkpointing an idle library keeps its at-rest
    # state a single consistent file rather than a torn triple.

    # Run the background maintenance pass (idle checkpoint + snapshot).
    sqlite_maintenance_enabled: bool = True

    # Seconds between maintenance passes, and how long a library must have gone
    # untouched before one applies to it. A checkpoint competes with live
    # readers, so it targets genuinely idle libraries.
    sqlite_maintenance_interval: float = 60.0
    sqlite_idle_checkpoint_after: float = 120.0

    # Seconds between consistent snapshots of a library DB to
    # ``.cairndex/library.db.bak`` (SQLite backup API). This is the heal path if
    # a machine's last sync ever shipped a mid-write state. Set to 0 to disable.
    sqlite_snapshot_interval: float = 86400.0

    # --- Library write mode (ADR-0013) --------------------------------------
    # Deployment master switch for guarded file operations inside a library root.
    # ``allowed`` (the default) means the per-library opt-in toggle is what
    # decides; ``disabled`` forces every library read-only no matter what its
    # registry flag says, for a hardened or shared deployment where nobody
    # should be able to turn writing on through the UI at all.
    write_mode: Literal["allowed", "disabled"] = "allowed"

    # How long a trashed file is kept before the retention sweep empties it for
    # good (ADR-0013 §3.2), in days. ``0`` — the default — keeps trash forever
    # and is the only setting that cannot lose data by surprise: the trash is
    # the way back from a deletion, so it expires only when the operator has
    # said how long "long enough" is. The sweep runs at library open, never on a
    # request path, and only ever empties operations already older than this.
    trash_retention_days: int = 0

    # Largest single file that may be imported into a library (ADR-0013 §7),
    # in bytes. ``0`` means no limit, which is the default: a legitimate import
    # here is a whole video file, and a cap generous enough never to reject one
    # would not be protecting anything on the single-owner LAN this is built
    # for. Set it on a deployment where the API is reachable by anyone whose
    # disk usage you would not want to underwrite.
    import_max_bytes: int = 0

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

    # Explicit ffmpeg/ffprobe locations. Unset, they are resolved from PATH and
    # then from conventional install prefixes (``media/tool_paths.py``). The
    # desktop shell sets these when spawning its local-server sidecar, because a
    # Finder-launched app inherits launchd's minimal PATH and would otherwise
    # miss a Homebrew ffmpeg entirely (plan 3 D6).
    ffmpeg_path: Path | None = None
    ffprobe_path: Path | None = None

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

    def deployment_allows_write_mode(self) -> bool:
        """Whether per-library write mode may be enabled on this deployment."""
        return self.write_mode == "allowed"

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

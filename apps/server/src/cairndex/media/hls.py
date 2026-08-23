"""Interactive HLS remux/transcode session manager (plan 1 §6.2, ADR-0014).

When a source can't be played directly (§6.1), we deliver it as HLS: one
``ffmpeg`` per session writes fMP4/CMAF segments sequentially into a server-local
ephemeral directory, and we serve those segments on demand. The playlist is a
**VOD** playlist computed up front so players get instant duration and free
native seeking; a seek far ahead of the encoder kills ffmpeg and restarts it at
the requested segment (``-ss`` + ``-start_number``).

Segment boundaries: transcode forces exact 6 s keyframes, so its playlist is a
uniform 6 s grid. Remux copies video and can only split at existing keyframes, so
its playlist is derived from a one-time keyframe scan of the source; a
duration-derived uniform grid would advertise phantom short segments and thrash
the encoder with restarts (measured — see ADR-0014). If the keyframe scan fails
we fall back to the uniform grid (accepting drift).

Sessions are interactive runtime state, **not** background jobs: they live in an
in-process registry (a dict guarded by locks), are bounded in number, are reaped
when idle, and are torn down on close/shutdown. Output goes under
``{CAIRNDEX_DATA_DIR}/transcode/{session_id}/`` — never inside a library package
(ADR-0014); ffmpeg args are built only from server-side-resolved paths.

Testability: the manager takes injectable command builder, keyframe prober, and
monotonic clock, so unit tests drive it with a fake ffmpeg stub and no real
media.
"""

from __future__ import annotations

import bisect
import contextlib
import math
import re
import secrets
import shutil
import subprocess
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from cairndex.core.errors import (
    CapacityError,
    MediaProcessingError,
    NotFoundError,
    ValidationError,
)
from cairndex.media import ffprobe, mp4_index, tonemap
from cairndex.media.ffmpeg_exec import ffmpeg_exe

# Segments target 6 s (plan 1 §6.2). fMP4 needs a shared init segment.
SEGMENT_DURATION = 6.0
INIT_NAME = "init.mp4"
_SEGMENT_RE = re.compile(r"^(\d+)\.m4s$")
DEFAULT_AHEAD_WINDOW = 5
DEFAULT_SEGMENT_WAIT = 20.0
DEFAULT_POLL_INTERVAL = 0.1
DEFAULT_KEYFRAME_TIMEOUT = 60.0
# ffmpeg gets a short grace period to exit on terminate before we SIGKILL it.
_TERMINATE_GRACE = 5.0

CommandBuilder = Callable[["HlsSession", int, float], list[str]]
KeyframeProber = Callable[[Path, float], "list[float] | None"]
Clock = Callable[[], float]


def _default_keyframe_prober(source: Path, timeout: float) -> list[float] | None:
    """Keyframe times for the remux playlist: MP4 index first, ffprobe second.

    Both produce the same list — verified byte-for-byte on real files — but not
    at the same cost. ffprobe demuxes the whole source to answer, which on a
    multi-GB file on a network volume is tens of seconds *inside the
    playback-decision request*, past the point the client gives up. The index
    read touches only the ``moov`` box. ffprobe still covers everything the
    parser declines: MKV and friends, fragmented MP4, unusual edit lists.
    """
    times = mp4_index.keyframe_times_from_mp4(source)
    if times:
        return times
    return ffprobe.keyframe_times(source, timeout=timeout)


@dataclass(frozen=True)
class BurnSubtitle:
    """A resolved burn-in subtitle source for a transcode session.

    ``path`` is the file ffmpeg reads (the external subtitle file, or the video
    itself for an embedded stream); ``stream_index`` is the *relative* subtitle
    index within that file for embedded streams (``None`` for a standalone file).
    """

    path: Path
    stream_index: int | None = None


@dataclass(frozen=True)
class SessionParams:
    """Immutable encode parameters chosen when a session is created.

    Equality drives session reuse (ADR-0014): a decision retry with identical
    params reuses the live session instead of spawning another and hitting the
    concurrency bound.
    """

    audio_stream_index: int | None = None
    audio_copy: bool = False
    max_height: int | None = None
    burn_subtitle: BurnSubtitle | None = None
    hwaccel: str | None = None
    # Normalized source video codec, needed by the remux path to decide whether
    # the copied stream must be relabelled (HEVC → hvc1). Constant per source, so
    # it does not fragment the equality-based session reuse above.
    video_codec: str | None = None
    # Source HDR signalling ("hdr10" | "hlg" | "dv" | None), which decides whether
    # the transcode needs a tone-map chain. Constant per source, like the codec.
    hdr: str | None = None


@dataclass
class HlsSession:
    """One interactive HLS session and its live ffmpeg process state."""

    id: str
    library_id: str
    file_id: str
    kind: str  # "remux" | "transcode"
    source_path: Path
    output_dir: Path
    duration: float
    segment_starts: list[float]  # source start time of each segment
    playlist: str  # VOD playlist, computed once at creation
    params: SessionParams
    # Runtime state, guarded by ``lock``.
    lock: threading.Lock = field(default_factory=threading.Lock)
    process: subprocess.Popen[bytes] | None = None
    run_start: int = 0  # start_number of the current ffmpeg run
    last_access: float = 0.0  # monotonic clock; drives idle reaping
    closed: bool = False
    failed: bool = False

    @property
    def segment_count(self) -> int:
        return len(self.segment_starts)


def _new_session_id() -> str:
    return secrets.token_hex(16)


def _segment_name(index: int) -> str:
    return f"{index}.m4s"


def _parse_segment_name(name: str) -> int | None:
    match = _SEGMENT_RE.match(name)
    return int(match.group(1)) if match else None


def _exists_nonempty(path: Path) -> bool:
    try:
        return path.stat().st_size > 0
    except OSError:
        return False


# --- segment boundary computation -------------------------------------------
def _uniform_segment_starts(duration: float) -> list[float]:
    count = max(1, math.ceil(duration / SEGMENT_DURATION))
    return [index * SEGMENT_DURATION for index in range(count)]


def _keyframe_segment_starts(keyframes: list[float], duration: float) -> list[float] | None:
    """Segment start times mirroring ``ffmpeg -hls_time 6 -c:v copy`` splits.

    Copy-mux starts a new segment at the first keyframe once the running segment
    has reached the target duration; we compute the same boundaries so the
    advertised playlist matches what ffmpeg actually emits (no phantom segments,
    no restart thrash). Returns ``None`` if the keyframes are unusable.
    """
    usable = sorted(kf for kf in keyframes if 0.0 < kf < duration)
    starts = [0.0]
    for kf in usable:
        if kf - starts[-1] >= SEGMENT_DURATION - 1e-3:
            starts.append(kf)
    return starts


def _render_playlist(segment_starts: list[float], duration: float) -> str:
    extinfs = [
        max(
            0.0,
            (segment_starts[index + 1] if index + 1 < len(segment_starts) else duration) - start,
        )
        for index, start in enumerate(segment_starts)
    ]
    # RFC 8216 §4.3.3.1: TARGETDURATION must be >= every segment duration.
    # Keyframe-derived remux segments can far exceed the 6 s target, so derive it
    # from the actual longest segment rather than hardcoding SEGMENT_DURATION.
    target = int(math.ceil(max(extinfs, default=SEGMENT_DURATION)))
    lines = [
        "#EXTM3U",
        "#EXT-X-VERSION:7",
        f"#EXT-X-TARGETDURATION:{target}",
        "#EXT-X-MEDIA-SEQUENCE:0",
        "#EXT-X-PLAYLIST-TYPE:VOD",
        f'#EXT-X-MAP:URI="{INIT_NAME}"',
    ]
    for index, extinf in enumerate(extinfs):
        lines.append(f"#EXTINF:{extinf:.3f},")
        lines.append(_segment_name(index))
    lines.append("#EXT-X-ENDLIST")
    return "\n".join(lines) + "\n"


def _segment_index_for(segment_starts: list[float], start_s: float) -> int:
    """Index of the segment whose source range contains ``start_s``."""
    index = bisect.bisect_right(segment_starts, start_s) - 1
    return max(0, min(index, len(segment_starts) - 1))


# --- ffmpeg command construction (plan 1 §6.2 templates) --------------------
# Capped software ladder: (max height, video maxrate, bufsize). The tier whose
# height does not exceed the target cap sets the bitrate; veryfast keeps NAS CPUs
# viable (§12). Hardware *encode* pipelines are out of scope for the MVP.
_LADDER: list[tuple[int, str, str]] = [
    (2160, "18M", "36M"),
    (1440, "10M", "20M"),
    (1080, "6M", "12M"),
    (720, "3M", "6M"),
    (480, "1500k", "3000k"),
    (360, "800k", "1600k"),
]


def _ladder_bitrate(target_height: int) -> tuple[str, str]:
    for height, maxrate, bufsize in _LADDER:
        if height <= target_height:
            return maxrate, bufsize
    return _LADDER[-1][1], _LADDER[-1][2]


def _escape_filter_path(path: Path) -> str:
    # libavfilter's subtitles= option parser treats ':' and '\' specially.
    text = str(path)
    return text.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")


def _transcode_filters(session: HlsSession) -> list[str]:
    """The ``-vf`` graph for a transcode, in an order that is load-bearing.

    Scale first: tone mapping runs through a float32 linear intermediate and is
    the expensive step, so it should see as few pixels as possible. Then tone
    map, because everything after it wants ordinary BT.709. Burn-in last for the
    same reason — overlaying subtitle graphics onto a linear-light frame blows
    them out.
    """
    filters: list[str] = []
    if session.params.max_height is not None:
        # Downscale only (never upscale), keeping even dimensions for yuv420p.
        filters.append(f"scale=-2:'min(ih,{session.params.max_height})'")
    if (session.params.hdr or "").lower() in tonemap.TONE_MAPPABLE and tonemap.enabled():
        # Without this the PQ or HLG code values reach `-pix_fmt yuv420p` and are
        # read as BT.709 gamma, which is the flat, washed-out picture.
        filters += tonemap.chain()
    burn = session.params.burn_subtitle
    if burn is not None:
        spec = f"subtitles={_escape_filter_path(burn.path)}"
        if burn.stream_index is not None:
            spec += f":si={burn.stream_index}"
        filters.append(spec)
    return filters


def _audio_args(session: HlsSession) -> list[str]:
    # Copy only when the source is already AAC (universally fMP4-safe); otherwise
    # transcode to stereo AAC — the plan's "AAC audio fallback" for remux/§6.2.
    if session.params.audio_copy:
        return ["-c:a", "copy"]
    return ["-c:a", "aac", "-ac", "2", "-b:a", "192k"]


def build_ffmpeg_command(session: HlsSession, start_number: int, start_s: float) -> list[str]:
    """Build the ffmpeg argv for a session run beginning at ``start_number``.

    Segment numbering is offset with ``-start_number`` so segment *n* maps to
    ``segment_starts[n]`` in the VOD playlist. The seek side matters for burn-in:
    a plain ``-vf subtitles`` overlay is applied at decode-time source PTS, so an
    input-side (fast) ``-ss`` would desync captions by ``start_s`` after a
    restart. Burn-in runs therefore use an output-side ``-ss`` (decode from 0,
    correct captions, slower seek); every other run uses the fast input seek.
    Transcode uses ``force_key_frames`` for exact 6 s boundaries; remux copies
    video and splits on source keyframes (its playlist is keyframe-derived).
    """
    burning = session.params.burn_subtitle is not None
    args = [ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-y"]
    if session.kind == "transcode" and session.params.hwaccel:
        args += ["-hwaccel", session.params.hwaccel]
    if start_s > 0 and not burning:
        args += ["-ss", f"{start_s:g}"]  # input-side fast seek
    args += ["-i", str(session.source_path)]
    if start_s > 0 and burning:
        args += ["-ss", f"{start_s:g}"]  # output-side seek keeps burn-in in sync

    args += ["-map", "0:v:0"]
    if session.params.audio_stream_index is not None:
        args += ["-map", f"0:{session.params.audio_stream_index}"]
    else:
        args += ["-map", "0:a:0?"]

    if session.kind == "remux":
        args += ["-c:v", "copy"]
        # Relabel HEVC to hvc1 on the way out. A copy preserves the source's
        # four-character tag, and AVFoundation refuses hev1 — so without this an
        # hev1 source remuxes into segments Safari and the desktop shell still
        # will not play. It rewrites a container field only; the coded picture
        # data is copied untouched, which is what keeps this a remux instead of
        # an expensive re-encode.
        if session.params.video_codec == "hevc":
            args += ["-tag:v", "hvc1"]
    else:
        target_height = session.params.max_height or 1080
        maxrate, bufsize = _ladder_bitrate(target_height)
        args += [
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "21",
            "-maxrate",
            maxrate,
            "-bufsize",
            bufsize,
            "-force_key_frames",
            f"expr:gte(t,n_forced*{SEGMENT_DURATION:g})",
            "-pix_fmt",
            "yuv420p",
        ]
        filters = _transcode_filters(session)
        if filters:
            args += ["-vf", ",".join(filters)]

    args += _audio_args(session)
    args += [
        "-f",
        "hls",
        "-hls_time",
        f"{SEGMENT_DURATION:g}",
        "-hls_playlist_type",
        "vod",
        "-hls_segment_type",
        "fmp4",
        "-hls_fmp4_init_filename",
        INIT_NAME,
        "-hls_flags",
        "independent_segments+temp_file",
        "-hls_segment_filename",
        str(session.output_dir / "%d.m4s"),
        "-start_number",
        str(start_number),
        str(session.output_dir / "ffmpeg.m3u8"),
    ]
    return args


def _launch_ffmpeg(args: list[str]) -> subprocess.Popen[bytes]:
    # stdout/stderr → DEVNULL: we never parse ffmpeg output (we watch the output
    # dir), and an unread PIPE can deadlock a long encode.
    return subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


class SessionManager:
    """In-process registry of bounded, idle-reaped HLS sessions (ADR-0014)."""

    def __init__(
        self,
        *,
        transcode_dir: Path,
        max_sessions: int = 2,
        idle_timeout: float = 60.0,
        command_builder: CommandBuilder = build_ffmpeg_command,
        keyframe_prober: KeyframeProber = _default_keyframe_prober,
        launcher: Callable[[list[str]], subprocess.Popen[bytes]] = _launch_ffmpeg,
        clock: Clock = time.monotonic,
        ahead_window: int = DEFAULT_AHEAD_WINDOW,
        segment_wait: float = DEFAULT_SEGMENT_WAIT,
        poll_interval: float = DEFAULT_POLL_INTERVAL,
        keyframe_timeout: float = DEFAULT_KEYFRAME_TIMEOUT,
        start_reaper: bool = True,
    ) -> None:
        self.transcode_dir = transcode_dir
        self.max_sessions = max_sessions
        self.idle_timeout = idle_timeout
        self._command_builder = command_builder
        self._keyframe_prober = keyframe_prober
        self._launcher = launcher
        self._clock = clock
        self._ahead_window = ahead_window
        self._segment_wait = segment_wait
        self._poll_interval = poll_interval
        self._keyframe_timeout = keyframe_timeout
        self._sessions: dict[str, HlsSession] = {}
        self._lock = threading.Lock()
        self._reaper: threading.Thread | None = None
        self._stop = threading.Event()
        self.transcode_dir.mkdir(parents=True, exist_ok=True)
        if start_reaper:
            self._start_reaper()

    # --- lifecycle ----------------------------------------------------------
    def create_session(
        self,
        *,
        library_id: str,
        file_id: str,
        source_path: Path,
        duration: float,
        kind: str,
        params: SessionParams,
        start_s: float = 0.0,
        reuse: bool = True,
    ) -> HlsSession:
        """Create (or reuse) and start a session; raise ``CapacityError`` past the bound.

        With ``reuse`` (the default) an existing live session with identical
        ``(library_id, file_id, kind, params)`` is returned instead of spawning
        another, so decision retries/reloads don't 429 against the bound.
        """
        if not (duration and duration > 0 and math.isfinite(duration)):
            raise ValidationError("cannot start a session for a file with unknown duration")

        if reuse:
            existing = self._find_reusable(library_id, file_id, kind, params)
            if existing is not None:
                return existing

        with self._lock:
            self._require_capacity()
        # Keyframe scan (remux only) runs outside the lock — it can be slow.
        segment_starts = self._segment_starts(kind, source_path, duration)
        playlist = _render_playlist(segment_starts, duration)

        with self._lock:
            if reuse:
                existing = self._match_locked(library_id, file_id, kind, params)
                if existing is not None:
                    existing.last_access = self._clock()
                    return existing
            self._require_capacity()
            session_id = _new_session_id()
            output_dir = self.transcode_dir / session_id
            output_dir.mkdir(parents=True, exist_ok=True)
            session = HlsSession(
                id=session_id,
                library_id=library_id,
                file_id=file_id,
                kind=kind,
                source_path=source_path,
                output_dir=output_dir,
                duration=duration,
                segment_starts=segment_starts,
                playlist=playlist,
                params=params,
                last_access=self._clock(),
            )
            self._sessions[session_id] = session
        with session.lock:
            self._start_run(session, _segment_index_for(segment_starts, start_s))
        return session

    def _require_capacity(self) -> None:
        """Raise ``CapacityError`` if at the session bound (caller holds lock)."""
        if sum(1 for s in self._sessions.values() if not s.closed) >= self.max_sessions:
            raise CapacityError(
                f"at most {self.max_sessions} concurrent playback sessions are allowed"
            )

    def _match_locked(
        self, library_id: str, file_id: str, kind: str, params: SessionParams
    ) -> HlsSession | None:
        for session in self._sessions.values():
            if (
                not session.closed
                and not session.failed
                and session.library_id == library_id
                and session.file_id == file_id
                and session.kind == kind
                and session.params == params
            ):
                return session
        return None

    def _find_reusable(
        self, library_id: str, file_id: str, kind: str, params: SessionParams
    ) -> HlsSession | None:
        with self._lock:
            session = self._match_locked(library_id, file_id, kind, params)
            if session is not None:
                session.last_access = self._clock()
            return session

    def _segment_starts(self, kind: str, source_path: Path, duration: float) -> list[float]:
        if kind == "remux":
            keyframes = self._keyframe_prober(source_path, self._keyframe_timeout)
            if keyframes:
                starts = _keyframe_segment_starts(keyframes, duration)
                if starts:
                    return starts
        return _uniform_segment_starts(duration)

    def get(self, library_id: str, session_id: str) -> HlsSession:
        """Return an open session scoped to ``library_id`` or raise 404."""
        with self._lock:
            session = self._sessions.get(session_id)
        if session is None or session.closed or session.library_id != library_id:
            raise NotFoundError(f"playback session {session_id!r} not found")
        return session

    def teardown(self, library_id: str, session_id: str) -> None:
        session = self.get(library_id, session_id)
        self._teardown(session)

    def shutdown(self) -> None:
        """Stop the reaper and tear down every session (server shutdown)."""
        self._stop.set()
        reaper = self._reaper
        if reaper is not None:
            reaper.join(timeout=2.0)
            self._reaper = None
        with self._lock:
            sessions = list(self._sessions.values())
        for session in sessions:
            self._teardown(session)

    # --- playlist + serving -------------------------------------------------
    def serve_playlist(self, library_id: str, session_id: str) -> str:
        session = self.get(library_id, session_id)
        with session.lock:
            if session.closed:
                raise NotFoundError("playback session was torn down")
            session.last_access = self._clock()
        return session.playlist

    def serve_artifact(self, library_id: str, session_id: str, artifact: str) -> Path:
        """Resolve one playlist artifact (init segment or media segment).

        The session lock is held only to read/update state and to (re)start
        ffmpeg — never across the bounded stat-poll wait — so parallel fetches
        serve concurrently and teardown can kill ffmpeg promptly.
        """
        session = self.get(library_id, session_id)
        with session.lock:
            if session.closed:
                raise NotFoundError("playback session was torn down")
            session.last_access = self._clock()
        if artifact == INIT_NAME:
            return self._serve_init(session)
        index = _parse_segment_name(artifact)
        if index is None or index < 0 or index >= session.segment_count:
            raise NotFoundError(f"segment {artifact!r} is out of range")
        return self._serve_segment(session, index)

    def _serve_init(self, session: HlsSession) -> Path:
        path = session.output_dir / INIT_NAME
        if _exists_nonempty(path):
            return path
        with session.lock:
            if session.closed:
                raise NotFoundError("playback session was torn down")
            self._ensure_running(session)
        if self._wait_for(session, path):
            return path
        self._raise_if_failed(session)
        raise NotFoundError("init segment is unavailable")

    def _serve_segment(self, session: HlsSession, index: int) -> Path:
        seg = session.output_dir / _segment_name(index)
        if _exists_nonempty(seg):
            return seg
        # First pass waits on the current run (if the segment is within reach);
        # a second pass forces a fresh restart at the segment. Between passes we
        # surface a genuine ffmpeg failure instead of a misleading restart loop.
        self._prepare_run(session, index, force_restart=False)
        if self._wait_for(session, seg):
            return seg
        self._raise_if_failed(session)
        self._prepare_run(session, index, force_restart=True)
        if self._wait_for(session, seg):
            return seg
        self._raise_if_failed(session)
        raise NotFoundError(f"segment {index} is unavailable")

    def _prepare_run(self, session: HlsSession, index: int, *, force_restart: bool) -> None:
        """Ensure a run that will produce ``index`` (brief lock, no blocking wait)."""
        with session.lock:
            if session.closed:
                raise NotFoundError("playback session was torn down")
            if _exists_nonempty(session.output_dir / _segment_name(index)):
                return
            frontier = self._frontier(session)
            within_reach = session.run_start <= index <= frontier + self._ahead_window
            if force_restart or not within_reach or not self._process_alive(session):
                self._start_run(session, index)

    def _raise_if_failed(self, session: HlsSession) -> None:
        """Raise if the current run exited nonzero (a real encoder failure)."""
        with session.lock:
            proc = session.process
            rc = proc.poll() if proc is not None else None
            if rc is not None and rc != 0:
                session.failed = True
                raise MediaProcessingError(f"playback session encoder exited with status {rc}")

    # --- ffmpeg process management ------------------------------------------
    def _start_run(self, session: HlsSession, start_number: int) -> None:
        """(Re)start ffmpeg at ``start_number`` (caller holds ``session.lock``)."""
        self._kill(session)
        session.run_start = start_number
        start_s = session.segment_starts[start_number]
        args = self._command_builder(session, start_number, start_s)
        session.process = self._launcher(args)

    def _ensure_running(self, session: HlsSession) -> None:
        has_init = _exists_nonempty(session.output_dir / INIT_NAME)
        if not self._process_alive(session) and not has_init:
            self._start_run(session, session.run_start)

    def _process_alive(self, session: HlsSession) -> bool:
        proc = session.process  # local ref: another thread may null it out
        return proc is not None and proc.poll() is None

    def _kill(self, session: HlsSession) -> None:
        proc = session.process
        session.process = None
        if proc is None or proc.poll() is not None:
            return
        proc.terminate()
        try:
            proc.wait(timeout=_TERMINATE_GRACE)
        except subprocess.TimeoutExpired:
            proc.kill()
            with contextlib.suppress(subprocess.TimeoutExpired):
                proc.wait(timeout=_TERMINATE_GRACE)

    def _frontier(self, session: HlsSession) -> int:
        """Highest media-segment index present on disk, or ``run_start - 1``."""
        highest = session.run_start - 1
        for entry in session.output_dir.glob("*.m4s"):
            match = _SEGMENT_RE.match(entry.name)
            if match:
                highest = max(highest, int(match.group(1)))
        return highest

    def _wait_for(self, session: HlsSession, path: Path) -> bool:
        """Poll (bounded, lock-free) for a complete ``path``; stop early once ffmpeg exits.

        Requires a non-empty file: ffmpeg opens the fMP4 init segment and writes
        it in stages, so an existence-only check can serve a truncated init.
        """
        deadline = self._clock() + self._segment_wait
        while True:
            if _exists_nonempty(path):
                return True
            alive = self._process_alive(session)
            if self._clock() >= deadline:
                return _exists_nonempty(path)
            if not alive:
                # One last look: the file may have landed as ffmpeg exited.
                time.sleep(self._poll_interval)
                return _exists_nonempty(path)
            time.sleep(self._poll_interval)

    def _teardown(self, session: HlsSession) -> None:
        with session.lock:
            if session.closed:
                return
            session.closed = True
            self._kill(session)
        with self._lock:
            self._sessions.pop(session.id, None)
        shutil.rmtree(session.output_dir, ignore_errors=True)

    # --- idle reaping -------------------------------------------------------
    def reap_idle(self) -> list[str]:
        """Tear down sessions with no fetch within ``idle_timeout``.

        Returns the ids reaped (handy for tests). Safe to call from the reaper
        thread or directly.
        """
        now = self._clock()
        with self._lock:
            stale = [
                s
                for s in self._sessions.values()
                if not s.closed and now - s.last_access > self.idle_timeout
            ]
        for session in stale:
            self._teardown(session)
        return [s.id for s in stale]

    def _start_reaper(self) -> None:
        self._reaper = threading.Thread(target=self._reaper_loop, name="hls-reaper", daemon=True)
        self._reaper.start()

    def _reaper_loop(self) -> None:
        interval = max(1.0, min(self.idle_timeout, 15.0))
        while not self._stop.wait(interval):
            # The reaper must never crash the app.
            with contextlib.suppress(Exception):  # pragma: no cover
                self.reap_idle()


# --- process-wide default manager -------------------------------------------
# The API uses a lazily-created singleton bound to config; tests inject their own
# manager (fake command builder / clock) via the FastAPI dependency, so the
# singleton stays uninvolved in unit tests.
_default_manager: SessionManager | None = None
_manager_lock = threading.Lock()


def get_session_manager() -> SessionManager:
    global _default_manager
    with _manager_lock:
        if _default_manager is None:
            from cairndex.core.config import get_settings

            settings = get_settings()
            _default_manager = SessionManager(
                transcode_dir=settings.data_dir / "transcode",
                max_sessions=settings.transcode_max_sessions,
                idle_timeout=settings.transcode_idle_timeout,
                ahead_window=settings.transcode_ahead_window,
                segment_wait=settings.transcode_segment_wait,
                keyframe_timeout=settings.transcode_keyframe_timeout,
            )
        return _default_manager


def shutdown_session_manager() -> None:
    global _default_manager
    with _manager_lock:
        manager = _default_manager
        _default_manager = None
    if manager is not None:
        manager.shutdown()

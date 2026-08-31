"""Pre-made hover previews for moments: a poster frame, and a clip for a span
(plan 7 §4.3, revised 2026-08-30).

A hover preview that streams the original file has to open a 100MB+ source, read
its header, seek into the middle, and decode forward from the preceding keyframe
before it can show the frame that was marked. Measured on a 1080p/30fps h264
file, that last step alone ran 14ms landing just after a keyframe and 123ms
landing just before the next one, and it grows with resolution and GOP length.
The owner's report was the plain version of it: the preview sits on a still for
about a second, and the still is not even inside the range.

So the span is cut once, in the background, and cached. A 480px muted clip with
its moov at the front plays from byte 0: no header round trip, no seek, no
decode-forward. Looping is free for the same reason, where seeking back to the
in-point paid the decode cost again on every repeat.

This is a return to the generated artifact the first draft had and the owner
rejected, and the reason it works now is *when* it runs, not *what* it makes.
Generating on the hover put the build in front of the picture, which is exactly
the wait complained about; generating behind a fallback means no hover ever waits
for ffmpeg. The route answers 404 until the file exists and the client keeps
streaming-and-seeking meanwhile, so the cache is pure speedup: delete
``.cairndex/cache/`` and every preview still works, just slowly again, and the
clips come back as the rows are hovered.

MP4 rather than the GIF first asked for: same instant playback, a fraction of
the bytes at the same quality, no 256-colour dithering, and no need for the
length cap that a GIF's size forced.

**The poster frame** is the other half, and it is what fixed the complaint the
clip did not. Under the video sits a still, so that the preview has a picture
before anything has decoded — and that still was a storyboard tile, which is
sampled on a 2-to-30 second grid and holds the frame at the *start* of the
interval containing the mark. So the first thing shown was reliably the wrong
frame: 4 seconds early on an hour-long video, 16 on a two-hour one (owner, twice:
"the initial frame is not part of the range").

The poster is one frame decoded at the marked instant, so it is simply right. It
serves a *frame* moment too, which has no span to play and so had nothing but
that stale tile — the same bug with no second act to correct it.

Cheap enough to make eagerly: one frame is a keyframe seek and a JPEG, so it is
queued when the moment is saved rather than on first hover, and the very first
hover is already correct. The lazy path stays as the fallback for moments that
predate this and for a cache someone emptied.

JPEG rather than WebP because it is the format the rest of the derived media here
already trusts an arbitrary ffmpeg build to encode — storyboard sheets and
contact sheets are both JPEG, and libwebp is not guaranteed present.
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from pathlib import Path

from cairndex.media import derived_cache
from cairndex.media.ffmpeg_exec import FfmpegError, ffmpeg_exe, run_ffmpeg
from cairndex.registry import library_package

CACHE_CONTROL = derived_cache.IMMUTABLE_CACHE_CONTROL

# The preview box is the width of an inspector row — a few hundred CSS pixels —
# so 480 is already generous on a HiDPI screen and keeps a clip in the tens of
# kilobytes and a poster in the hundreds of bytes.
PREVIEW_WIDTH = 480
# The longest span cut in full. Not a limit on what may be *marked*: a longer
# range still previews, from the first minute of it, and the row states the real
# duration. This bounds encode work, nothing the owner sees — the 30s cap that
# was visible in the range bar (and disliked, 2026-08-30) is gone.
MAX_CLIP_SECONDS = 60.0
# Encoding a minute of 480p is seconds of work, but a pathological source should
# not pin a worker forever.
CLIP_TIMEOUT_SECONDS = 120.0
# One frame is one seek and one JPEG; anything near this is a broken source.
POSTER_TIMEOUT_SECONDS = 30.0

# At most two previews encode at once, matching the image decoder's bound: a
# sweep down a long list of moments must not turn into a fork bomb of ffmpeg
# processes.
_ENCODE_SLOTS = threading.BoundedSemaphore(2)
# Destinations already being built, so a second hover during a build does not
# queue a duplicate behind the semaphore. `derived_cache.locked` guards *across*
# processes; this guards within one.
_IN_FLIGHT: set[Path] = set()
_IN_FLIGHT_LOCK = threading.Lock()


def _cache_path(library_root: Path, moment_id: str, name: str) -> Path:
    """One moment's artifact, under a name that is unique *before* the extension.

    `derived_cache` derives an artifact's fingerprint sidecar and lock with
    `with_suffix`, so two artifacts of the same moment distinguished only by
    extension would share both: `{id}.mp4` and `{id}.jpg` both resolve to
    `{id}.fingerprint`. That is not theoretical — it was the first shape of this
    code. The clip's fingerprint overwrote the poster's, `is_current` then failed
    for the poster forever, and every range moment fell back to the stale
    storyboard tile on every hover while quietly re-encoding its poster each
    time. A frame moment, having only one artifact, looked perfectly fine — which
    is why it survived a round of testing. So the kind goes in the stem, not the
    suffix.
    """
    root = library_package.cache_dir(library_root) / "moment-previews"
    return root / moment_id[:2] / f"{moment_id}-{name}"


# Return the deterministic cache path for one moment's preview clip
def clip_cache_path(library_root: Path, moment_id: str) -> Path:
    return _cache_path(library_root, moment_id, "clip.mp4")


# Return the deterministic cache path for one moment's poster frame
def poster_cache_path(library_root: Path, moment_id: str) -> Path:
    return _cache_path(library_root, moment_id, "poster.jpg")


def clip_fingerprint(quick_fingerprint: str | None, start: float, end: float) -> str:
    """The cache identity of a clip: its source's bytes *and* its span.

    The span is in the fingerprint rather than the filename because a moment's
    identity is its row: re-marking a span reuses the id, and without the bounds
    here a moved span would keep serving the clip of where it used to be.
    """
    return f"{quick_fingerprint or 'no-fingerprint'}:{start:.3f}-{end:.3f}"


def poster_fingerprint(quick_fingerprint: str | None, start: float) -> str:
    """The cache identity of a poster: its source's bytes and the instant it holds.

    The end of a span is deliberately absent — moving only the out-point leaves
    the first frame exactly where it was, so the poster does not need rebuilding.
    """
    return f"{quick_fingerprint or 'no-fingerprint'}@{start:.3f}"


def is_current(dest: Path, fingerprint: str) -> bool:
    return derived_cache.is_current(dest, fingerprint)


def schedule(dest: Path, build: Callable[[], None]) -> None:
    """Run a build off the request entirely.

    Deliberately *not* Starlette's ``BackgroundTasks``. Those run before FastAPI
    exits the ``yield`` dependencies, so the library session's commit waits for
    them — and a poster queued from ``POST /moments`` therefore held its own
    moment's write invisible until ffmpeg finished. The client's refetch fires
    about 20ms after the POST, read an empty list, and nothing invalidated again,
    so the rail stayed empty until the app was reloaded (owner-reported,
    2026-08-30: "it does not render until I reload the app"). Measured at 2121ms
    of invisibility with the encode slowed to 2000ms, and on a large source the
    real encode is slow enough to lose that race every time.

    It is the same hazard on the *read* routes for a different reason: a
    background task there delays the teardown of the library access dependency,
    holding it across an ffmpeg run.

    A daemon thread instead, so the response, the commit, and the encode are
    independent. Concurrency stays bounded by ``_ENCODE_SLOTS``; daemon so a
    killed sidecar is never held open by an encode.

    The in-flight check happens *here* rather than only inside ``_build``, so a
    sweep down a rail of unbuilt previews — every row asking for the same
    destination as the pointer passes over it — does not spawn a thread per ask
    just to have it find the work already claimed and return.
    """
    with _IN_FLIGHT_LOCK:
        if dest in _IN_FLIGHT:
            return
    threading.Thread(target=build, name="cairndex-moment-preview", daemon=True).start()


def _build(dest: Path, fingerprint: str, make: Callable[[Path], None]) -> None:
    """Make one cached artifact, at most once concurrently per destination.

    Takes plain values rather than a session: this runs after the response has
    been sent, and a DB connection held across an ffmpeg run is exactly the kind
    of stranding that the scoped-session rule exists to prevent.
    """
    with _IN_FLIGHT_LOCK:
        if dest in _IN_FLIGHT:
            return
        _IN_FLIGHT.add(dest)
    try:
        with _ENCODE_SLOTS, derived_cache.locked(dest):
            # Another process may have finished it while this one queued.
            if derived_cache.is_current(dest, fingerprint):
                return
            dest.parent.mkdir(parents=True, exist_ok=True)
            # Written aside and moved into place, so a reader never opens a
            # half-encoded file that a fingerprint has not yet vouched for.
            tmp = dest.with_suffix(f".partial{dest.suffix}")
            try:
                make(tmp)
                tmp.replace(dest)
            finally:
                tmp.unlink(missing_ok=True)
            derived_cache.write_fingerprint(dest, fingerprint)
    except (FfmpegError, OSError):
        # A preview that cannot be built is not an error the owner needs to see:
        # a range keeps its streaming fallback and a frame keeps its storyboard
        # tile. Left uncached so the next hover retries rather than remembering
        # the failure forever.
        dest.unlink(missing_ok=True)
    finally:
        with _IN_FLIGHT_LOCK:
            _IN_FLIGHT.discard(dest)


def request_clip(source: Path, dest: Path, *, start: float, end: float, fingerprint: str) -> None:
    """Cut one span into a small looping clip."""
    duration = min(max(end - start, 0.0), MAX_CLIP_SECONDS)
    _build(dest, fingerprint, lambda tmp: _encode_clip(source, tmp, start=start, duration=duration))


def request_poster(source: Path, dest: Path, *, at: float, fingerprint: str) -> None:
    """Decode the one frame a moment marks."""
    _build(dest, fingerprint, lambda tmp: _encode_poster(source, tmp, at=at))


# `-ss` before `-i` so ffmpeg jumps to the preceding keyframe instead of decoding
# the file from its start — the same reason contact sheets seek per frame. It is
# accurate all the same when re-encoding: ffmpeg decodes and discards from that
# keyframe up to the requested time, so frame one is the instant that was marked
# and not the keyframe before it.
def _seek_input(source: Path, at: float) -> list[str]:
    return [ffmpeg_exe(), "-hide_banner", "-nostdin", "-y", "-ss", f"{at:.3f}", "-i", str(source)]


def _encode_clip(source: Path, dest: Path, *, start: float, duration: float) -> None:
    run_ffmpeg(
        [
            *_seek_input(source, start),
            "-t",
            f"{duration:.3f}",
            "-an",
            "-sn",
            "-vf",
            f"scale={PREVIEW_WIDTH}:-2:flags=bicubic",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "28",
            "-pix_fmt",
            "yuv420p",
            # The whole point: the header at the front, so the client's first
            # request can start decoding instead of paying a round trip to find
            # the moov.
            "-movflags",
            "+faststart",
            str(dest),
        ],
        timeout=CLIP_TIMEOUT_SECONDS,
    )


def _encode_poster(source: Path, dest: Path, *, at: float) -> None:
    run_ffmpeg(
        [
            *_seek_input(source, at),
            "-frames:v",
            "1",
            "-an",
            "-sn",
            "-vf",
            f"scale={PREVIEW_WIDTH}:-2:flags=bicubic",
            "-q:v",
            "4",
            str(dest),
        ],
        timeout=POSTER_TIMEOUT_SECONDS,
    )

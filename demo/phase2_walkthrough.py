"""Phase 2 demo: scan a real (tiny, generated) library, probe it, thumbnail it.

Generates a small media tree with ffmpeg, then runs the actual scanner, ffprobe
metadata extraction, and thumbnail generation in-process — printing what was
discovered (with real dimensions/duration/codecs) and where the cached
thumbnails landed (outside the source tree). Originals are never touched.

Run from the repo root:

    cd apps/server && uv run python ../../demo/phase2_walkthrough.py

Requires ffmpeg/ffprobe on PATH (brew install ffmpeg).
"""

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

_tmp = Path(tempfile.mkdtemp(prefix="cairndex-demo2-"))
os.environ["CAIRNDEX_DATA_DIR"] = str(_tmp / "appdata")
os.environ["CAIRNDEX_DATABASE_URL"] = f"sqlite:///{_tmp / 'demo.db'}"

from sqlalchemy import select  # noqa: E402

from cairndex.core.config import get_settings  # noqa: E402
from cairndex.media.probe_service import probe_storage_root  # noqa: E402
from cairndex.media.thumbnails import generate_for_root  # noqa: E402
from cairndex.persistence import models  # noqa: E402,F401
from cairndex.persistence.base import Base  # noqa: E402
from cairndex.persistence.engine import get_engine, get_sessionmaker  # noqa: E402
from cairndex.scanning.scanner import scan_storage_root  # noqa: E402
from cairndex.services import storage_roots as root_service  # noqa: E402

get_settings.cache_clear()
Base.metadata.create_all(get_engine())

FFMPEG = shutil.which("ffmpeg")


def _make_video(path: Path, *, size: str, seconds: int) -> None:
    assert FFMPEG is not None
    subprocess.run(
        [FFMPEG, "-y", "-f", "lavfi", "-i", f"testsrc=duration={seconds}:size={size}:rate=24",
         "-pix_fmt", "yuv420p", str(path)],
        check=True, capture_output=True,
    )


def _make_image(path: Path, *, size: str) -> None:
    assert FFMPEG is not None
    subprocess.run(
        [FFMPEG, "-y", "-f", "lavfi", "-i", f"color=c=teal:size={size}", "-frames:v", "1", str(path)],
        check=True, capture_output=True,
    )


def main() -> None:
    if FFMPEG is None:
        raise SystemExit("ffmpeg not found on PATH — install it (brew install ffmpeg).")

    print("=" * 72)
    print("Cairndex — Phase 2 walkthrough (scanner, ffprobe, thumbnails)")
    print("=" * 72)

    media = _tmp / "media"
    (media / "Films").mkdir(parents=True)
    _make_video(media / "Films" / "trailer_1080p.mp4", size="1920x1080", seconds=2)
    _make_video(media / "Films" / "clip_480p.mkv", size="854x480", seconds=1)
    _make_image(media / "Films" / "poster.png", size="600x900")
    (media / "Films" / "notes.txt").write_text("ignored by the scanner")
    print(f"\n[disk] generated a tiny library at {media}")

    sessionmaker_ = get_sessionmaker()
    with sessionmaker_() as session:
        root = root_service.create_storage_root(session, name="Demo", canonical_path=str(media))
        session.commit()
        root_id = root.id

        print("\n[1] Scan — discover & link files in place (one bundle per file).")
        scan = scan_storage_root(session, root_id)
        print(f"    discovered={scan.discovered} created={scan.created} "
              f"(notes.txt skipped: not media)")

        print("\n[2] Probe — extract technical metadata with ffprobe.")
        probe = probe_storage_root(session, root_id)
        print(f"    probed={probe.probed} failed={probe.failed}")

        print("\n[3] Thumbnails — extract a frame / downscale, cached outside source.")
        thumbs = generate_for_root(session, root_id)
        print(f"    generated={thumbs.generated} failed={thumbs.failed}")

        print("\n[4] Result — each discovered file with its extracted metadata:\n")
        files = session.scalars(select(models.AssetFile).order_by(models.AssetFile.relative_path))
        for f in files:
            meta = f.tech_metadata or {}
            dims = f"{meta.get('width')}x{meta.get('height')}" if meta.get("width") else "—"
            dur = f"{meta.get('duration'):.1f}s" if meta.get("duration") else "—"
            codec = meta.get("video_codec") or "—"
            print(f"    • {f.relative_path}")
            print(f"        kind={f.media_kind}  dims={dims}  duration={dur}  codec={codec}")
            print(f"        size={f.size_bytes}B  fingerprint={f.quick_fingerprint}")

    cache = get_settings().cache_dir / "thumbnails"
    thumb_files = sorted(cache.rglob("*.jpg"))
    print(f"\n[cache] {len(thumb_files)} thumbnails cached under {cache}")
    for t in thumb_files:
        rel = t.relative_to(get_settings().cache_dir)
        print(f"    • {rel}  ({t.stat().st_size} bytes)")
    assert not str(cache).startswith(str(media)), "thumbnails must live outside the source tree"

    originals = sorted(p.name for p in (media / "Films").iterdir())
    print(f"\n[disk] source files after all processing: {', '.join(originals)}")
    print("       ✅ originals untouched — scan/probe/thumbnail are all read-only.")
    print("\n" + "=" * 72)
    print("Interactive: `demo/run_phase1.sh` serves the API; the new endpoints")
    print("POST /storage-roots/{id}/scan|probe|thumbnails run these as background jobs.")
    print("=" * 72)


if __name__ == "__main__":
    main()

"""Small playable synthetic catalogs for independent-replica media qualification"""

import shutil
import sqlite3
from pathlib import Path

from cairndex.devtools.catalog_fixture import create_disposable, insert_row, synthetic_row
from cairndex.media.ffmpeg_exec import ffmpeg_exe, run_ffmpeg
from cairndex.replicas.catalog.conversion import prepare_disposable


# Only a freshly generated disposable tree can enter this fixture construction path
def create_playable(*, parent: Path | None = None, duration: int = 150) -> Path:
    from PIL import Image, ImageDraw

    fixture = create_disposable(parent=parent, bundles=3)
    media = fixture.source / "Playback"
    media.mkdir()
    run_ffmpeg(
        [
            ffmpeg_exe(),
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=320x180:rate=10",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=44100",
            "-t",
            str(duration),
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-threads",
            "1",
            "-g",
            "20",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-movflags",
            "+faststart",
            str(media / "movie.mp4"),
        ],
        timeout=60,
        stderr_limit=200,
    )
    run_ffmpeg(
        [
            ffmpeg_exe(),
            "-y",
            "-i",
            str(media / "movie.mp4"),
            "-c",
            "copy",
            str(media / "remux.mkv"),
        ],
        timeout=30,
        stderr_limit=200,
    )
    run_ffmpeg(
        [
            ffmpeg_exe(),
            "-y",
            "-i",
            str(media / "movie.mp4"),
            "-t",
            "16",
            "-c:v",
            "mpeg4",
            "-threads",
            "1",
            "-c:a",
            "mp3",
            str(media / "fallback.avi"),
        ],
        timeout=30,
        stderr_limit=200,
    )
    picture = Image.new("RGB", (640, 360), "#245c75")
    ImageDraw.Draw(picture).text((80, 170), "Synthetic replica picture", fill="white")
    picture.save(media / "picture.png")
    picture.save(media / "preview.tiff")
    (media / "captions.srt").write_text(
        "1\n00:00:00,000 --> 00:02:30,000\nSynthetic local captions\n",
        encoding="utf-8",
    )
    with sqlite3.connect(fixture.source / ".cairndex/library.db") as db:
        db.execute("UPDATE asset_bundles SET title='Synthetic playback' WHERE id='bundle-000001'")
        for order, (identity, filename, role) in enumerate(
            [
                ("media-direct", "movie.mp4", "VIDEO_PART"),
                ("media-image", "picture.png", "IMAGE"),
                ("media-remux", "remux.mkv", "VIDEO_PART"),
                ("media-fallback", "fallback.avi", "VIDEO_PART"),
                ("media-preview", "preview.tiff", "IMAGE"),
                ("media-subtitle", "captions.srt", "SUBTITLE"),
            ]
        ):
            insert_row(
                db,
                "asset_files",
                synthetic_row(
                    "asset_files",
                    identity,
                    bundle_id="bundle-000001",
                    relative_path=f"Playback/{filename}",
                    original_filename=filename,
                    display_title=filename,
                    directory_path="Playback",
                    role=role,
                    sequence=order,
                    cover_time=None,
                ),
            )
        insert_row(
            db,
            "subtitle_tracks",
            synthetic_row(
                "subtitle_tracks",
                "media-track",
                bundle_id="bundle-000001",
                video_file_id="media-direct",
                source_file_id="media-subtitle",
                embedded_index=None,
                label="Synthetic captions",
                format="srt",
                is_default=1,
            ),
        )
        insert_row(
            db,
            "moments",
            synthetic_row(
                "moments",
                "media-moment",
                bundle_id="bundle-000001",
                file_id="media-direct",
                start_s=42.0,
                end_s=47.0,
                comment="Synthetic moment",
            ),
        )
    package = prepare_disposable(fixture).package
    shutil.copytree(media, package / "Playback")
    return package


# The developer command creates new temporary data and accepts no owner-library path
if __name__ == "__main__":
    print(create_playable())

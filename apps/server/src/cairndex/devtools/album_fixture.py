"""Disposable paginated albums with generated images and optional video."""

import shutil
import sqlite3
from pathlib import Path

from PIL import Image, ImageDraw

from cairndex.devtools.catalog_fixture import (
    DisposableCatalog,
    create_disposable,
    insert_row,
    synthetic_row,
)
from cairndex.media.ffmpeg_exec import ffmpeg_exe, run_ffmpeg
from cairndex.replicas.catalog.conversion import prepare_disposable


def prepare_album(*, parent: Path | None = None, video: bool = False) -> DisposableCatalog:
    fixture = create_disposable(parent=parent, bundles=3)
    picture = Image.new("RGB", (320, 180), "#246f91")
    ImageDraw.Draw(picture).text((20, 80), "Synthetic album", fill="white")
    with sqlite3.connect(fixture.source / ".cairndex/library.db") as db:
        db.execute(
            "UPDATE asset_bundles SET title='Synthetic album',cover_file_id='loose-000' "
            "WHERE id='bundle-000001'"
        )
        for group, count in [("Loose", 62), ("Gallery", 125), ("Gallery2", 1)]:
            for index in range(count):
                path = f"{group}/frame{index:03}.png"
                dest = fixture.source / path
                dest.parent.mkdir(exist_ok=True)
                picture.save(dest)
                insert_row(
                    db,
                    "asset_files",
                    synthetic_row(
                        "asset_files",
                        f"{group.lower()}-{index:03}",
                        bundle_id="bundle-000001",
                        relative_path=path,
                        directory_path=group,
                        original_filename=dest.name,
                        role="IMAGE",
                        sequence=index,
                        cover_time=None,
                    ),
                )
        for identity, directory, order in [
            ("album-folder", "Gallery", 1),
            ("empty-folder", "Empty", 2),
        ]:
            insert_row(
                db,
                "bundle_directory_members",
                synthetic_row(
                    "bundle_directory_members",
                    identity,
                    bundle_id="bundle-000001",
                    directory_path=directory,
                    sequence=order,
                ),
            )
        for index, path in enumerate(
            ["Gallery/.hidden.png", "Gallery/.private/frame.png", "Gallery/__pycache__/frame.png"]
        ):
            insert_row(
                db,
                "asset_files",
                synthetic_row(
                    "asset_files",
                    f"album-hidden-{index}",
                    bundle_id="bundle-000001",
                    relative_path=path,
                    directory_path=path.rpartition("/")[0],
                    original_filename="frame.png",
                    role="IMAGE",
                    sequence=0,
                ),
            )
        if video:
            dest = fixture.source / "Loose/movie.mp4"
            run_ffmpeg(
                [
                    ffmpeg_exe(),
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc2=size=320x180:rate=10",
                    "-t",
                    "5",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "ultrafast",
                    "-threads",
                    "1",
                    "-pix_fmt",
                    "yuv420p",
                    "-movflags",
                    "+faststart",
                    str(dest),
                ],
                timeout=30,
            )
            insert_row(
                db,
                "asset_files",
                synthetic_row(
                    "asset_files",
                    "album-video",
                    bundle_id="bundle-000001",
                    relative_path="Loose/movie.mp4",
                    directory_path="Loose",
                    original_filename="movie.mp4",
                    role="VIDEO_PART",
                    sequence=70,
                ),
            )
    return fixture


def create_album(*, parent: Path | None = None) -> Path:
    fixture = prepare_album(parent=parent, video=True)
    package = prepare_disposable(fixture).package
    for name in ("Loose", "Gallery", "Gallery2"):
        shutil.copytree(fixture.source / name, package / name)
    return package


if __name__ == "__main__":
    print(create_album())

"""Phase 1 demo: a narrated end-to-end walkthrough of the core domain.

Runs the real API (in-process, against a throwaway SQLite DB and a temp folder
of fake "media") and prints each step so you can see what Phase 1 built:
storage roots, bundles, metadata-only file linking, cover/primary selection,
hierarchical tags + tag groups, multi-folder membership, and the proof that
removing metadata never touches files on disk.

Run from the repo root:

    cd apps/server && uv run python ../../demo/phase1_walkthrough.py
"""

import os
import tempfile
from pathlib import Path

# Use a throwaway database + data dir so the demo never touches real state.
_tmp = Path(tempfile.mkdtemp(prefix="cairndex-demo-"))
os.environ["CAIRNDEX_DATA_DIR"] = str(_tmp)
os.environ["CAIRNDEX_DATABASE_URL"] = f"sqlite:///{_tmp / 'demo.db'}"

from fastapi.testclient import TestClient  # noqa: E402

from cairndex.core.config import get_settings  # noqa: E402
from cairndex.persistence import models  # noqa: E402,F401
from cairndex.persistence.base import Base  # noqa: E402
from cairndex.persistence.engine import get_engine  # noqa: E402

get_settings.cache_clear()
Base.metadata.create_all(get_engine())

from cairndex.main import app  # noqa: E402

client = TestClient(app)


def show(title: str, response: object) -> dict:
    import json

    from httpx import Response

    assert isinstance(response, Response)
    body = response.json() if response.content else {}
    print(f"\n  ▶ {title}")
    print(f"    {response.request.method} {response.request.url.path} → {response.status_code}")
    if body:
        rendered = json.dumps(body, indent=2)
        for line in rendered.splitlines():
            print(f"      {line}")
    return body if isinstance(body, dict) else {}


def main() -> None:
    print("=" * 70)
    print("Cairndex — Phase 1 walkthrough (core domain & storage roots)")
    print("=" * 70)

    # A fake on-disk library we will link in place (never copied/moved).
    media = _tmp / "media" / "Blade Runner (1982)"
    media.mkdir(parents=True)
    for name, content in [
        ("part1.mkv", "reel one"),
        ("part2.mkv", "reel two"),
        ("cover.jpg", "poster"),
        ("subs.en.srt", "1\n00:00:01,000 --> 00:00:04,000\nHello"),
    ]:
        (media / name).write_text(content)
    print(f"\n[disk] created a fake library at: {media}")
    print("       files:", ", ".join(sorted(p.name for p in media.iterdir())))

    print("\n[1] Register the storage root (links files in place — read-only).")
    root = show(
        "create storage root",
        client.post(
            "/api/v1/storage-roots",
            json={"name": "Demo NAS", "canonical_path": str(_tmp / "media")},
        ),
    )

    print("\n[2] Create one Asset Bundle (the primary card), then link 4 files.")
    bundle = show("create bundle", client.post("/api/v1/bundles", json={"title": "Blade Runner"}))
    bundle_id, root_id = bundle["id"], root["id"]

    def link(rel: str, role: str, kind: str) -> dict:
        return show(
            f"link {role}",
            client.post(
                f"/api/v1/bundles/{bundle_id}/files",
                json={
                    "storage_root_id": root_id,
                    "relative_path": rel,
                    "role": role,
                    "media_kind": kind,
                },
            ),
        )

    cover = link("Blade Runner (1982)/cover.jpg", "cover", "image")
    primary = link("Blade Runner (1982)/part1.mkv", "primary_video", "video")
    link("Blade Runner (1982)/part2.mkv", "video_part", "video")
    link("Blade Runner (1982)/subs.en.srt", "subtitle", "subtitle")

    print("\n[3] Set shared metadata + choose the cover and primary file.")
    show(
        "update bundle",
        client.patch(
            f"/api/v1/bundles/{bundle_id}",
            json={
                "note": "Final Cut",
                "source_url": "https://example.com/blade-runner",
                "rating": 5,
                "cover_file_id": cover["id"],
                "primary_file_id": primary["id"],
            },
        ),
    )

    print("\n[4] Hierarchical tags across tag groups (a tag can be in many groups).")
    genre = client.post("/api/v1/tags", json={"name": "genre"}).json()
    scifi = client.post("/api/v1/tags", json={"name": "sci-fi", "parent_id": genre["id"]}).json()
    group = client.post("/api/v1/tag-groups", json={"name": "Genre"}).json()
    client.put(f"/api/v1/tag-groups/{group['id']}/tags", json={"tag_ids": [genre["id"], scifi["id"]]})
    show(
        "assign tags to the bundle",
        client.put(f"/api/v1/bundles/{bundle_id}/tags", json={"ids": [genre["id"], scifi["id"]]}),
    )

    print("\n[5] Put the bundle in multiple hierarchical folders.")
    films = client.post("/api/v1/folders", json={"name": "Films"}).json()
    yr = client.post("/api/v1/folders", json={"name": "1982", "parent_id": films["id"]}).json()
    show(
        "assign folders to the bundle",
        client.put(f"/api/v1/bundles/{bundle_id}/folders", json={"ids": [films["id"], yr["id"]]}),
    )

    print("\n[6] The bundle's files, ordered (one card, four files):")
    show("list files", client.get(f"/api/v1/bundles/{bundle_id}/files"))

    print("\n[7] Metadata-only & non-destructive: delete the whole bundle...")
    show("delete bundle", client.delete(f"/api/v1/bundles/{bundle_id}"))
    still_there = sorted(p.name for p in media.iterdir())
    print(f"\n[disk] files still on disk after deletion: {', '.join(still_there)}")
    assert len(still_there) == 4, "files must be untouched!"
    print("       ✅ every original file is untouched — Cairndex only removed metadata.")

    print("\n" + "=" * 70)
    print("Done. This same API powers the Swagger UI at http://localhost:8000/docs")
    print("(run `demo/run_phase1.sh` to seed a library and explore it interactively).")
    print("=" * 70)


if __name__ == "__main__":
    main()

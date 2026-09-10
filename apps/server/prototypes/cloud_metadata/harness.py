"""Deterministic delivery between disposable synthetic replicas, with no network access"""

import shutil
import tempfile
from pathlib import Path
from typing import Any

from .replica import Replica, initialize


# Generate every fixture at runtime; no database or media artifact belongs in Git
def seed() -> dict[str, Any]:
    result: dict[str, Any] = {}
    for entity in ("bundle", "image", "video", "amber", "blue"):
        result[f"entity/{entity}/title"] = f"Synthetic {entity}"
    result.update(
        {
            "entity/bundle/note": "Seed note",
            "entity/bundle/rating": 0,
            "entity/image/path": "synthetic-image.png",
            "entity/video/path": "synthetic-video.mp4",
            "tree/collections": {"root": ["amber", "blue"], "amber": [], "blue": []},
            "order/bundle": ["image", "video"],
        }
    )
    return result


# Copy only provider-facing files; private SQLite and drafts never enter transport
# Tests may select, reorder, truncate or duplicate these ordinary files explicitly
def deliver(source: Replica, target: Replica) -> None:
    for directory in ("payloads", "commits"):
        for path in sorted((source.root / "transport" / directory).iterdir()):
            if path.suffix == ".json":
                shutil.copyfile(path, target.root / "transport" / directory / path.name)


# Pair creation pins both devices to the same already-generated genesis
class Pair:
    # Both replicas stay open until test teardown
    def __init__(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="cairndex-cloud-synthetic-")
        root = Path(self.temp.name)
        initialize(root / "A")
        initialize(root / "B")
        self.a = Replica(root / "A", "replica-A")
        self.genesis = self.a.edit(seed(), operation="genesis")
        self.a.publish()
        self.b = Replica(root / "B", "replica-B", genesis=self.genesis)
        deliver(self.a, self.b)
        self.b.receive()

    # Polling both sides requires no exclusive-device handoff
    def sync(self) -> None:
        self.a.publish()
        self.b.publish()
        deliver(self.a, self.b)
        deliver(self.b, self.a)
        self.a.receive()
        self.b.receive()

    # Teardown only the two marked temporary roots created by this harness
    def close(self) -> None:
        self.a.close()
        self.b.close()
        self.temp.cleanup()

"""Generate an empty synthetic replica fixture; never convert an existing library"""

import json
import tempfile
from pathlib import Path
from uuid import uuid4

from cairndex.replicas.protocol import (
    CAPABILITY,
    PACKAGE_FORMAT,
    Descriptor,
    Seed,
    SeedBundle,
    envelope,
)


# The empty-directory guard prevents this development tool from touching an owner's catalog
# The only content created is the explicit synthetic baseline below
def create_fixture(root: Path) -> Descriptor:
    root.mkdir(parents=True, exist_ok=True)
    if any(root.iterdir()):
        raise ValueError("Synthetic fixture requires a new empty directory")
    library, epoch = uuid4().hex, uuid4().hex
    seed = Seed(
        protocol=1,
        kind="seed",
        library=library,
        epoch=epoch,
        bundles=[
            SeedBundle(
                id="synthetic-bundle",
                title="Synthetic bundle",
                notes=["First note", "Second note"],
                rating=2.5,
            ),
        ],
    )
    genesis, raw = envelope(seed)
    descriptor = Descriptor(
        format=PACKAGE_FORMAT,
        format_version=1,
        library_uuid=library,
        display_name="Synthetic replica",
        epoch=epoch,
        genesis=genesis,
        capabilities=[CAPABILITY],
    )
    metadata = root / ".cairndex"
    shard = metadata / "replica" / "objects" / genesis[:2]
    shard.mkdir(parents=True)
    (shard / f"{genesis}.json").write_bytes(raw)
    (metadata / "manifest.json").write_text(descriptor.model_dump_json())
    return descriptor


# CLI accepts no existing-library path and uploads nothing
# The printed path is a disposable fixture the caller may register for local testing
def main() -> None:
    root = Path(tempfile.mkdtemp(prefix="cairndex-replica-synthetic-"))
    descriptor = create_fixture(root)
    print(json.dumps({"root": str(root), "library_uuid": descriptor.library_uuid}))


if __name__ == "__main__":
    main()

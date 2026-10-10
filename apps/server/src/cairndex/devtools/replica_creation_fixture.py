"""Allocate fresh synthetic roots for resumable empty-catalog creation."""

import tempfile
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class DisposableCreation:
    """A developer fixture, not permission to adopt an existing library."""

    directory: Path

    @property
    def root(self) -> Path:
        return self.directory / "package"

    @property
    def private(self) -> Path:
        return self.directory / "private"


def prepare_disposable(*, parent: Path | None = None) -> DisposableCreation:
    """Allocate a new tree and persist its creation intent before publication."""
    from cairndex.replicas.catalog.creation import prepare

    fixture = DisposableCreation(
        Path(tempfile.mkdtemp(prefix="cairndex-creation-synthetic-", dir=parent)).resolve()
    )
    (fixture.root / ".cairndex").mkdir(parents=True)
    fixture.private.mkdir(mode=0o700)
    prepare(fixture)
    return fixture

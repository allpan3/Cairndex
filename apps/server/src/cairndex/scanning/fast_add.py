"""Fast add: manually link selected files or directories into bundles.

Unlike a full scan, the caller chooses exactly what to add and how to group it
(one bundle per file, or one bundle for the whole selection). Directories are
expanded to the media files they contain. Already-linked files are skipped, so
fast-add is safe to repeat. Nothing on disk is modified.
"""

from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from cairndex.core.errors import ValidationError
from cairndex.core.paths import PathSafetyError, normalize_relative_path, resolve_within_root
from cairndex.domain.enums import Grouping
from cairndex.persistence.models import AssetBundle, AssetFile
from cairndex.scanning.fingerprint import quick_fingerprint
from cairndex.scanning.media_types import classify
from cairndex.scanning.scanner import _iter_media_files
from cairndex.services.storage_roots import get_storage_root


@dataclass(frozen=True)
class FastAddResult:
    bundles_created: int
    files_linked: int
    skipped: int


def fast_add(
    session: Session,
    root_id: str,
    *,
    paths: list[str],
    grouping: Grouping = Grouping.PER_FILE,
    bundle_title: str | None = None,
) -> FastAddResult:
    root = get_storage_root(session, root_id)
    root_path = Path(root.canonical_path)

    # Expand the selection to concrete, in-root media files (deduped, ordered).
    candidates: dict[str, Path] = {}
    for raw in paths:
        try:
            normalized = normalize_relative_path(raw)
            resolved = resolve_within_root(root_path, normalized)
        except PathSafetyError as exc:
            raise ValidationError(str(exc)) from exc
        if resolved.is_dir():
            for media in _iter_media_files(resolved):
                rel = normalize_relative_path(media.relative_to(root_path).as_posix())
                candidates.setdefault(rel, media)
        elif resolved.is_file() and classify(resolved.name) is not None:
            candidates.setdefault(normalized, resolved)
        # Missing paths and non-media files are silently ignored.

    already_linked = {
        rel
        for (rel,) in session.execute(
            select(AssetFile.relative_path).where(AssetFile.storage_root_id == root_id)
        )
    }
    to_link = {rel: path for rel, path in candidates.items() if rel not in already_linked}

    skipped = len(candidates) - len(to_link)
    if not to_link:
        return FastAddResult(0, 0, skipped)

    if grouping is Grouping.SINGLE_BUNDLE:
        title = bundle_title or next(iter(to_link.values())).stem
        bundle = AssetBundle(title=title)
        session.add(bundle)
        session.flush()
        for sequence, (rel, path) in enumerate(to_link.items()):
            _link(session, bundle.id, root_id, rel, path, sequence=sequence)
        bundles_created = 1
    else:
        for rel, path in to_link.items():
            bundle = AssetBundle(title=path.stem)
            session.add(bundle)
            session.flush()
            _link(session, bundle.id, root_id, rel, path, sequence=0)
        bundles_created = len(to_link)

    session.commit()
    return FastAddResult(bundles_created, len(to_link), skipped)


def _link(
    session: Session, bundle_id: str, root_id: str, rel: str, path: Path, *, sequence: int
) -> None:
    classification = classify(path.name)
    assert classification is not None
    kind, role = classification
    stat = path.stat()
    session.add(
        AssetFile(
            bundle_id=bundle_id,
            storage_root_id=root_id,
            relative_path=rel,
            original_filename=path.name,
            display_title=path.name,
            role=role,
            media_kind=kind,
            sequence=sequence,
            size_bytes=stat.st_size,
            mtime=datetime.fromtimestamp(stat.st_mtime, UTC),
            quick_fingerprint=quick_fingerprint(stat.st_size, stat.st_mtime_ns),
        )
    )
    session.flush()

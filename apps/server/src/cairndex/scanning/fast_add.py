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
from cairndex.core.time import utcnow
from cairndex.domain.enums import Grouping, GroupingSource, GroupingState
from cairndex.persistence.engine import library_root_for_session
from cairndex.persistence.models import AssetBundle, AssetFile
from cairndex.scanning.fingerprint import quick_fingerprint
from cairndex.scanning.media_types import classify
from cairndex.scanning.scanner import iter_media_files
from cairndex.services.subtitles import auto_link_external_subtitles


@dataclass(frozen=True)
class FastAddResult:
    bundles_created: int
    files_linked: int
    skipped: int
    subtitles_linked: int = 0


def fast_add(
    session: Session,
    *,
    paths: list[str],
    grouping: Grouping = Grouping.PER_FILE,
    bundle_title: str | None = None,
) -> FastAddResult:
    """Link selected files/dirs under the library root (ADR-0008). The library
    root is derived from the bound content session."""
    root_path = library_root_for_session(session)
    # Expand the selection to concrete, in-root media files (deduped, ordered).
    candidates: dict[str, Path] = {}
    for raw in paths:
        try:
            normalized = normalize_relative_path(raw)
            resolved = resolve_within_root(root_path, normalized)
        except PathSafetyError as exc:
            raise ValidationError(str(exc)) from exc
        if resolved.is_dir():
            for media in iter_media_files(resolved):
                rel = normalize_relative_path(media.relative_to(root_path).as_posix())
                candidates.setdefault(rel, media)
        elif resolved.is_file() and classify(resolved.name) is not None:
            candidates.setdefault(normalized, resolved)
        # Missing paths and non-media files are silently ignored.

    already_linked = {rel for (rel,) in session.execute(select(AssetFile.relative_path))}
    to_link = {rel: path for rel, path in candidates.items() if rel not in already_linked}

    skipped = len(candidates) - len(to_link)
    if not to_link:
        return FastAddResult(0, 0, skipped)

    subtitles_linked = 0
    if grouping is Grouping.SINGLE_BUNDLE:
        title = bundle_title or next(iter(to_link.values())).stem
        bundle = _new_confirmed_bundle(title)
        session.add(bundle)
        session.flush()
        for sequence, (rel, path) in enumerate(to_link.items()):
            _link(session, bundle.id, rel, path, sequence=sequence)
        # Grouping a video with its external .srt/.vtt should link them, just as
        # the grouping-apply flow does (ADR-0009 phase 6 / ADR-0003).
        subtitles_linked = len(auto_link_external_subtitles(session, bundle.id))
        bundles_created = 1
    else:
        for rel, path in to_link.items():
            bundle = _new_confirmed_bundle(path.stem)
            session.add(bundle)
            session.flush()
            _link(session, bundle.id, rel, path, sequence=0)
        bundles_created = len(to_link)

    session.commit()
    return FastAddResult(bundles_created, len(to_link), skipped, subtitles_linked)


def _new_confirmed_bundle(title: str) -> AssetBundle:
    """A fast-add bundle is confirmed on creation: the user chose the grouping
    directly, so it never needs review (ADR-0009)."""
    return AssetBundle(
        title=title,
        grouping_state=GroupingState.CONFIRMED,
        grouping_source=GroupingSource.FAST_ADD,
        confirmed_at=utcnow(),
    )


def _link(session: Session, bundle_id: str, rel: str, path: Path, *, sequence: int) -> None:
    classification = classify(path.name)
    assert classification is not None
    kind, role = classification
    stat = path.stat()
    session.add(
        AssetFile(
            bundle_id=bundle_id,
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

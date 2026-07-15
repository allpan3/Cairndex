"""Shared, metadata-only bundle-membership mutations.

Moving asset files into a bundle and then reaping any provisional source bundle
the move emptied is common to grouping-plan apply (ADR-0009) and the manual
bundling assistant. Centralized here so both share one implementation that keeps
``AssetFile.id`` stable (so subtitles, thumbnails, notes, and cover
references survive) and never touches the filesystem.
"""

from __future__ import annotations

from collections.abc import Iterable

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from cairndex.persistence.models import AssetBundle, AssetFile


def clear_dangling_refs(session: Session, bundle: AssetBundle) -> None:
    """Null a bundle's cover reference when it no longer points at one of
    its own files (e.g. after a split moved that file elsewhere)."""
    for attr in ("cover_file_id",):
        ref_id = getattr(bundle, attr)
        if ref_id is not None:
            ref = session.get(AssetFile, ref_id)
            if ref is None or ref.bundle_id != bundle.id:
                setattr(bundle, attr, None)


def reap_source_bundles(session: Session, source_bundles: Iterable[AssetBundle]) -> int:
    """Delete source bundles a move fully emptied; repair dangling cover
    references on any that still hold files (a partial move / split). Returns the
    number of bundles deleted."""
    removed = 0
    for bundle in source_bundles:
        remaining = (
            session.scalar(
                select(func.count()).select_from(AssetFile).where(AssetFile.bundle_id == bundle.id)
            )
            or 0
        )
        if remaining == 0:
            session.delete(bundle)
            removed += 1
        else:
            clear_dangling_refs(session, bundle)
    return removed

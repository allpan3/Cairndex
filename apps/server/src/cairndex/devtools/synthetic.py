"""Deterministic synthetic-library generator.

Produces tags, tag groups, folders, and asset bundles with linked files using
only synthetic relative paths — no real media is touched (AGENTS.md §15). Used
by tests and by the seed CLI to populate a dev database for exercising the
browsing UI at scale (Phase 3).
"""

import random
from dataclasses import dataclass

from sqlalchemy.orm import Session

from cairndex.core.ids import new_id
from cairndex.domain.enums import FileRole, MediaKind
from cairndex.services import bundles as bundle_service
from cairndex.services import folders as folder_service
from cairndex.services import storage_roots as root_service
from cairndex.services import tag_groups as group_service
from cairndex.services import tags as tag_service

_TAG_GROUPS = ["Genre", "Mood", "Status", "Source"]
_GENRES = ["thriller", "drama", "comedy", "documentary", "sci-fi", "horror"]
_MOODS = ["calm", "intense", "uplifting", "dark"]
_FOLDERS = ["Films", "Series", "Shorts", "Archive"]


@dataclass(frozen=True)
class SeedSummary:
    storage_root_id: str
    tags: int
    tag_groups: int
    folders: int
    bundles: int
    files: int


def seed_synthetic_library(
    session: Session,
    *,
    n_bundles: int = 500,
    seed: int = 42,
    root_path: str = "/synthetic-media",
) -> SeedSummary:
    rng = random.Random(seed)

    root = root_service.create_storage_root(
        session,
        name=f"synthetic-{new_id()[:8]}",
        canonical_path=root_path,
    )

    groups = [group_service.create_tag_group(session, name=n) for n in _TAG_GROUPS]
    genre_parent = tag_service.create_tag(session, name="genre")
    genre_tags = [
        tag_service.create_tag(session, name=g, parent_id=genre_parent.id) for g in _GENRES
    ]
    mood_tags = [tag_service.create_tag(session, name=m) for m in _MOODS]
    all_tags = [genre_parent, *genre_tags, *mood_tags]
    group_service.set_group_tags(
        session, groups[0].id, [genre_parent.id, *(t.id for t in genre_tags)]
    )
    group_service.set_group_tags(session, groups[1].id, [t.id for t in mood_tags])

    folders = [folder_service.create_folder(session, name=n) for n in _FOLDERS]
    sub_folders = [
        folder_service.create_folder(session, name=f"{rng.randint(2000, 2026)}", parent_id=f.id)
        for f in folders
    ]
    all_folders = [*folders, *sub_folders]

    file_count = 0
    for i in range(n_bundles):
        bundle = bundle_service.create_bundle(
            session,
            title=f"Synthetic Bundle {i:05d}",
            rating=rng.choice([None, 1, 2, 3, 4, 5]),
        )
        # 1–3 files per bundle (a primary video, optional part, optional cover).
        bundle_service.add_file(
            session,
            bundle.id,
            storage_root_id=root.id,
            relative_path=f"dir{i % 64:03d}/clip{i:05d}.mp4",
            role=FileRole.PRIMARY_VIDEO,
            media_kind=MediaKind.VIDEO,
        )
        file_count += 1
        if rng.random() < 0.4:
            bundle_service.add_file(
                session,
                bundle.id,
                storage_root_id=root.id,
                relative_path=f"dir{i % 64:03d}/clip{i:05d}_cover.jpg",
                role=FileRole.COVER,
                media_kind=MediaKind.IMAGE,
            )
            file_count += 1

        chosen_tags = rng.sample(all_tags, k=rng.randint(0, 3))
        if chosen_tags:
            bundle_service.set_bundle_tags(session, bundle.id, [t.id for t in chosen_tags])
        chosen_folders = rng.sample(all_folders, k=rng.randint(0, 2))
        if chosen_folders:
            bundle_service.set_bundle_folders(session, bundle.id, [f.id for f in chosen_folders])

    session.flush()
    return SeedSummary(
        storage_root_id=root.id,
        tags=len(all_tags),
        tag_groups=len(groups),
        folders=len(all_folders),
        bundles=n_bundles,
        files=file_count,
    )

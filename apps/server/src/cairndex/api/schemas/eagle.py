"""Schemas for the Eagle import preview (dry run) and commit."""

from pydantic import BaseModel


class EagleImportRequest(BaseModel):
    library_path: str


class MergeSuggestionRead(BaseModel):
    reason: str
    item_ids: list[str]


class ImportPlanRead(BaseModel):
    library_path: str
    total_items: int
    new_bundles: int
    skipped_existing: int
    skipped_deleted: int
    folders: int
    tags: int
    tag_groups: int
    merge_suggestions: list[MergeSuggestionRead]
    warnings: list[str]


class ImportResultRead(BaseModel):
    bundles_created: int
    # Eagle folders import into Cairndex collections.
    collections_created: int
    tags_created: int
    tag_groups_created: int
    skipped: int

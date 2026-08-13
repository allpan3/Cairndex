"""API schemas for grouping plans and apply results (ADR-0009 phase 3)."""

from datetime import datetime
from typing import Annotated, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from cairndex.domain.enums import (
    STEM_LEVEL_CEILING,
    FileRole,
    GroupingPlanStatus,
    ProposalKind,
)

# How much of each filename has to match, per directory (``DEFAULT_STEM_LEVEL``
# when a directory is absent). Bounded only for hygiene: the server clamps every
# level to the folder's own maximum, above which the grouping cannot change.
StemLevel = Annotated[int, Field(ge=0, le=STEM_LEVEL_CEILING)]


class ProposalFileRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    asset_file_id: str
    relative_path: str
    proposed_role: FileRole
    sequence: int


class ProposalRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    kind: ProposalKind
    title: str | None
    directory: str
    parent_proposal_id: str | None
    # When set, this proposal adds its files to an existing confirmed bundle.
    target_bundle_id: str | None
    target_bundle_title: str | None
    create_new_bundle: bool
    # Existing collection represented by this structural placement node
    target_collection_id: str | None
    # True only for a synthesized read-only node standing in for a live
    # collection. An ordinary folder suggestion may also resolve to an existing
    # collection (so apply reuses it rather than duplicating it) while staying
    # editable, so the client must gate its read-only rendering on this and not
    # on ``target_collection_id``.
    is_collection_context: bool
    confidence: float
    reason: str | None
    files: list[ProposalFileRead]


# Validate the editable fields accepted for an open grouping proposal
class ProposalUpdate(BaseModel):
    title: str = Field(min_length=1, max_length=1024)


# Validate an addition proposal's reversible destination choice
class ProposalDestinationUpdate(BaseModel):
    create_new_bundle: bool


# Validate a stable-id file transfer between bundle suggestions
class ProposalFileMove(BaseModel):
    target_proposal_id: str
    target_index: int = Field(ge=0)


# Validate a bundle or new-collection suggestion's persisted or proposed parent
class ProposalReparent(BaseModel):
    # Unknown keys are refused: both destinations are nullable, so a misspelled
    # one would otherwise be dropped silently and read as "move to the top
    # level" — detaching the proposal instead of filing it.
    model_config = ConfigDict(extra="forbid")

    parent_proposal_id: str | None = None
    target_collection_id: str | None = None

    # Reject a destination that names two different parent domains
    @model_validator(mode="after")
    def one_destination(self) -> Self:
        if self.parent_proposal_id is not None and self.target_collection_id is not None:
            raise ValueError("choose either a collection suggestion or an existing collection")
        # Moving to the top level is a real request, but it has to be *asked* for:
        # an empty body used to be a 422 and must not become a silent detach.
        if not self.model_fields_set:
            raise ValueError(
                "name a destination, or send an explicit null to move to the top level"
            )
        return self


# Validate a suggestion's bundle-versus-collection override
class ProposalKindUpdate(BaseModel):
    kind: ProposalKind


# Validate one directory's stem-level change (in-place re-suggestion)
class StemLevelUpdate(BaseModel):
    directory: str = Field(max_length=4096)
    level: StemLevel


# Validate bounded per-directory stem level overrides
class PlanGenerateRequest(BaseModel):
    stem_levels: dict[str, StemLevel] = Field(default_factory=dict, max_length=500)


# One folder's position on the stem dial, and how far the dial goes
class StemLevelRead(BaseModel):
    level: StemLevel
    # The level at which every filename in this folder is down to its first
    # segment. Folder-specific, so the client is told rather than deriving it.
    max: StemLevel


class PlanRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    status: GroupingPlanStatus
    rule_version: int
    scan_job_id: str | None
    # Every folder the plan's files come from, not only the overridden ones — the
    # review needs a level and a maximum for each folder it shows a control on.
    # Filled by the route from ``plan_store.stem_levels``; it cannot come from the
    # plan row, which stores overrides alone.
    stem_levels: dict[str, StemLevelRead] = Field(default_factory=dict)
    generated_at: datetime
    applied_at: datetime | None
    proposals: list[ProposalRead]


class PlanSummary(BaseModel):
    id: str
    status: GroupingPlanStatus
    rule_version: int
    generated_at: datetime
    applied_at: datetime | None
    proposal_count: int


class ApplyPlanRequest(BaseModel):
    proposal_ids: list[str] | None = None


class ApplyConflictRead(BaseModel):
    proposal_id: str
    title: str | None
    reason: str


class ApplyResultRead(BaseModel):
    bundles_confirmed: int
    bundles_removed: int
    collections_created: int
    bundles_added_to_collections: int
    files_added_to_bundles: int
    subtitles_linked: int
    conflicts: list[ApplyConflictRead]

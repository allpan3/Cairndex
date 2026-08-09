"""API schemas for grouping plans and apply results (ADR-0009 phase 3)."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from cairndex.domain.enums import FileRole, GroupingPlanStatus, ProposalKind, StemMode


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


# Validate a bundle or new-collection suggestion's parent edit
class ProposalReparent(BaseModel):
    parent_proposal_id: str | None


# Validate a suggestion's bundle-versus-collection override
class ProposalKindUpdate(BaseModel):
    kind: ProposalKind


# Validate one directory's stem-sensitivity change (in-place re-suggestion)
class StemModeUpdate(BaseModel):
    directory: str = Field(max_length=4096)
    mode: StemMode


# Validate bounded per-directory stem sensitivity overrides
class PlanGenerateRequest(BaseModel):
    stem_modes: dict[str, StemMode] = Field(default_factory=dict, max_length=500)


class PlanRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    status: GroupingPlanStatus
    rule_version: int
    scan_job_id: str | None
    stem_modes: dict[str, StemMode]
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

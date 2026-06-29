"""API schemas for grouping plans and apply results (ADR-0009 phase 3)."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict

from cairndex.domain.enums import FileRole, GroupingPlanStatus, ProposalKind


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
    confidence: float
    reason: str | None
    files: list[ProposalFileRead]


class PlanRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    status: GroupingPlanStatus
    rule_version: int
    scan_job_id: str | None
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

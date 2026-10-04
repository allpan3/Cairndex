"""Shared catalog API contracts with exact value text, durable jobs and mandatory observed bases"""

from typing import Any, Literal

from pydantic import Field

from cairndex.replicas.protocol import Digest, StrictModel, Token

Family = Literal[
    "asset_bundles",
    "asset_files",
    "bundle_directory_members",
    "tags",
    "tag_groups",
    "collections",
    "smart_folders",
    "moments",
    "subtitle_tracks",
    "asset_bundle_tags",
    "asset_bundle_collections",
    "moment_tags",
    "tag_group_memberships",
]


# Values are canonical SQLite-cell JSON text so browsers never round opaque numeric values
class CatalogCandidate(StrictModel):
    value: str
    revisions: list[Digest]


# Missing projected values remain explicit during incomplete/conflicted creation
class CatalogField(StrictModel):
    unit: str
    value: str | None
    basis: list[Digest]
    candidates: list[CatalogCandidate]
    held: str | None
    components: dict[str, str]


# A snapshot carries exact lifetime/reference bases and the complete observed frontier
class CatalogEntity(StrictModel):
    has_conflicts: bool
    family: str
    id: str
    fields: dict[str, CatalogField]
    observed: dict[str, list[Digest]]
    parents: list[Digest]


# Every family supports deterministic cursor pagination including retained deleted identities
class CatalogPage(StrictModel):
    items: list[CatalogEntity]
    next_cursor: str | None


# Only bounded commands enter handlers; semantic validation and structural work run in jobs
class CatalogJobRequest(StrictModel):
    operation: Token
    action: Literal["save", "preview", "commit_preview", "recover"]
    body: dict[str, Any]


# A queued job is durable intent, while a succeeded save contains the authored event receipt
class CatalogJob(StrictModel):
    id: Token
    action: Literal["save", "preview", "commit_preview", "recover"]
    state: Literal["queued", "running", "succeeded", "failed", "cancelled"]
    result: dict[str, Any] | None
    error: str | None
    receipt: Digest | None


# Job lists omit large results and page by durable insertion order
class CatalogJobPage(StrictModel):
    items: list[CatalogJob]
    next_cursor: int | None


# Draft bodies preserve invalid text inputs as well as valid causal save requests
class CatalogDraftRequest(StrictModel):
    revision: int = Field(ge=1, le=2_000_000_000)
    body: dict[str, Any]


# Field controls describe the existing authored model without exposing private observations
class CatalogControl(StrictModel):
    field: str
    label: str
    kind: Literal["text", "number", "boolean", "json", "enum", "reference", "structure", "lifetime"]
    nullable: bool
    choices: list[str] = Field(default_factory=list)
    reference_family: str | None = None
    columns: list[str] = Field(default_factory=list)

"""Explicit editor basis, draft identity and bounded replica responses"""

from typing import Literal, Self

from pydantic import Field, model_validator

from cairndex.replicas.protocol import (
    MAX_BYTES,
    Change,
    Digest,
    FieldName,
    StrictModel,
    Token,
    Value,
    canonical,
)


# Every retry names exactly one intent; an omitted basis is never last-write-wins
class SaveRequest(StrictModel):
    operation: Token
    changes: dict[FieldName, Change] = Field(min_length=1, max_length=3)
    resolve: bool = False


# Draft sequencing protects newer keystrokes from delayed HTTP delivery
class DraftRequest(StrictModel):
    revision: int = Field(ge=1, le=2_000_000_000)
    changes: dict[FieldName, Change] = Field(max_length=3)

    @model_validator(mode="after")
    def bounded(self) -> Self:
        """Keep private drafts within the same supported transaction budget"""
        if len(canonical(self.model_dump())) > MAX_BYTES:
            raise ValueError("draft too large")
        return self


# Provider publication is distinguishable from an unavailable peer receipt
class ReplicaStatus(StrictModel):
    browse_version: int | None = None
    album_version: int | None = None
    inspector_version: int | None = None
    selection_version: int | None = None
    system_views_version: int | None = None
    catalog_version: int | None = None
    media_version: int | None = None
    discovery_version: int | None = None
    ready: bool
    blocked: str | None
    outbox: int
    waiting: int
    invalid: int
    peer_delivery: Literal["unknown"]
    exchange_error: str | None = None


# Equal values retain all contributing revisions without unnecessary conflict prompts
class Candidate(StrictModel):
    value: Value
    revisions: list[Digest]


# The last good local value remains explicit alongside unresolved candidates
class ReplicaField(StrictModel):
    value: Value
    basis: list[Digest]
    candidates: list[Candidate]


# Every capable bundle returns all supported fields, including explicit null ratings
class BundleFields(StrictModel):
    title: ReplicaField
    notes: ReplicaField
    rating: ReplicaField


# Unsupported relationships are absent from this capability rather than partially projected
class ReplicaBundle(StrictModel):
    id: Token
    fields: BundleFields


# Bundle lists remain paginated even for the bounded initial seed format
class ReplicaBundlePage(StrictModel):
    items: list[ReplicaBundle]
    next_cursor: str | None


# A response receipt confirms a local durable save only
class SaveReceipt(StrictModel):
    event: Digest


# Rejected active alternatives remain addressable after resolution
class HistoryItem(StrictModel):
    revision: Digest
    value: Value
    active: bool


# Retained revisions are read in bounded pages
class HistoryPage(StrictModel):
    items: list[HistoryItem]
    next_cursor: str | None


# Drafts are per-editor private records and never cloud artifacts
class DraftItem(DraftRequest):
    id: Token


# A new editor can recover previous private drafts without erasing its own input
class DraftPage(StrictModel):
    items: list[DraftItem]
    next_cursor: str | None

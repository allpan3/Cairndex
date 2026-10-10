"""Bounded private Update and reviewed grouping routes for capable replicas"""

from typing import Any

from fastapi import APIRouter, Query, Response
from pydantic import Field

from cairndex.api.v1.catalog_replicas import Catalog
from cairndex.replicas import discovery_state as state
from cairndex.replicas import discovery_verification as verification
from cairndex.replicas.protocol import Digest, StrictModel, Token

router = APIRouter(prefix="/libraries/{library_id}/replica/discovery", tags=["replica-discovery"])


# A request starts work without enumerating a directory or inspecting media
class DiscoveryStart(StrictModel):
    operation: Token


# Ordering edits refer only to files already held in the private candidate
class DiscoveryMove(StrictModel):
    file: str = Field(max_length=64)
    before: str = Field(max_length=64)


# Selection defaults to all members and preserves ordering edits independently of paging
class DiscoveryPrepare(StrictModel):
    operation: Token
    candidate: Digest
    title: str | None = Field(default=None, max_length=512)
    target: str | None = Field(default=None, max_length=64)
    files: list[str] | None = Field(default=None, min_length=1)
    exclude_files: list[str] | None = None
    groups: list[str] | None = Field(default=None, min_length=1)
    exclude_groups: list[str] | None = None
    collection: str | None = Field(default=None, max_length=64)
    moves: list[DiscoveryMove] = Field(default_factory=list)
    repair_file: str | None = Field(default=None, max_length=64)
    use_replacement: bool = False
    verification: Token | None = None


# Verification explicitly scopes complete reads to an immutable private suggestion
class DiscoveryVerify(StrictModel):
    operation: Token
    candidate: Digest


# Accept acknowledges the exact preview currently displayed to the owner
class DiscoveryAccept(StrictModel):
    receipt: Digest


# Progress includes completed observations and repairs, never a guessed directory total
@router.get("/status")
def status(store: Catalog) -> dict[str, Any]:
    return state.run(store)


# Stable enqueue identities preserve safe retries after a lost response
@router.post("/runs", status_code=202)
def start(payload: DiscoveryStart, store: Catalog) -> dict[str, Any]:
    return state.enqueue(store, payload.operation)


# Cancellation is private and leaves already committed events intact
@router.delete("/runs/{operation}", status_code=204)
def cancel(operation: Token, store: Catalog) -> Response:
    state.cancel(store, operation)
    return Response(status_code=204)


# Pending suggestions remain paged and isolated from the authored catalog
@router.get("/candidates")
def candidates(
    store: Catalog, after: str = "", limit: int = Query(default=30, ge=1, le=50)
) -> dict[str, Any]:
    return state.candidates(store, after, limit)


# Source pages retain the complete candidate identity while allowing arbitrarily many members
@router.get("/candidates/{candidate}/files")
def candidate_files(
    candidate: Digest,
    store: Catalog,
    after: int = -1,
    limit: int = Query(default=50, ge=1, le=50),
) -> dict[str, Any]:
    from cairndex.replicas.discovery_proposals import files

    with store.connection(readonly=True) as db:
        return files(db, candidate, after, limit)


# Collection review pages name descendants and every required ancestor before preparation
@router.get("/candidates/{candidate}/groups")
def candidate_groups(
    candidate: Digest,
    store: Catalog,
    after: str = "",
    limit: int = Query(default=50, ge=1, le=50),
) -> dict[str, Any]:
    from cairndex.replicas.discovery_pages import groups

    with store.connection(readonly=True) as db:
        return groups(db, candidate, after, limit)


# Missing-identity choices remain complete and keep the selected option visible across pages
@router.get("/candidates/{candidate}/choices")
def candidate_choices(
    candidate: Digest, store: Catalog, after: str = "", selected: str = ""
) -> dict[str, Any]:
    from cairndex.replicas.discovery_choices import page

    with store.connection(readonly=True) as db:
        return page(db, candidate, after, selected)


# Preparation captures the user selection before a background worker touches catalog relationships
@router.post("/reviews", status_code=202)
def prepare(payload: DiscoveryPrepare, store: Catalog) -> dict[str, Any]:
    return state.prepare(
        store, payload.operation, payload.model_dump(exclude={"operation"}, exclude_unset=True)
    )


# Recover queued/ready/applied reviews independently of the browser session
@router.get("/reviews")
def reviews(
    store: Catalog, after: str = "", limit: int = Query(default=30, ge=1, le=50)
) -> dict[str, Any]:
    with store.connection(readonly=True) as db:
        rows = db.execute(
            "SELECT id FROM discovery_reviews WHERE id>? ORDER BY id LIMIT ?", (after, limit + 1)
        ).fetchall()
    return {
        "items": [state.review(store, row[0]) for row in rows[:limit]],
        "next_cursor": rows[limit - 1][0] if len(rows) > limit else None,
    }


# Reopening a review returns its exact prepared bytes and never auto-applies
@router.get("/reviews/{operation}")
def review(operation: Token, store: Catalog) -> dict[str, Any]:
    return state.review(store, operation)


# Complete prepared files, placements and metadata values remain inspectable in bounded pages
@router.get("/reviews/{operation}/pages/{kind}")
def review_page(
    operation: Token,
    kind: str,
    store: Catalog,
    after: int = -1,
    limit: int = Query(default=50, ge=1, le=50),
) -> dict[str, Any]:
    from cairndex.replicas.discovery_pages import review_page

    with store.connection(readonly=True) as db:
        return review_page(db, operation, kind, after, limit)


# Commit is asynchronous and revalidates source observations before authoring
@router.post("/reviews/{operation}/accept", status_code=202)
def accept(operation: Token, payload: DiscoveryAccept, store: Catalog) -> dict[str, Any]:
    return state.accept(store, operation, payload.receipt)


# Closing a queued preview is reversible and cannot accidentally authorize a queued commit
@router.delete("/reviews/{operation}", status_code=204)
def cancel_review(operation: Token, store: Catalog) -> Response:
    with store.connection() as db:
        db.execute(
            (
                "UPDATE discovery_reviews SET state='cancelled' WHERE id=? AND "
                "state IN ('queued','ready','apply_queued')"
            ),
            (operation,),
        )
    return Response(status_code=204)


# Request handlers enqueue complete reads and never hash source content
@router.post("/verifications", status_code=202)
def verify(payload: DiscoveryVerify, store: Catalog) -> dict[str, Any]:
    return verification.enqueue(store, payload.operation, payload.candidate)


# Byte progress is visible without reopening the media source
@router.get("/verifications/{operation}")
def verification_status(operation: Token, store: Catalog) -> dict[str, Any]:
    return verification.status(store, operation)


# Cancelling a hash retains its exact candidate and every completed receipt
@router.delete("/verifications/{operation}", status_code=204)
def cancel_verification(operation: Token, store: Catalog) -> Response:
    verification.cancel(store, operation)
    return Response(status_code=204)

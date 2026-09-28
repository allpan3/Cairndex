"""Library-scoped bundle metadata workflow for explicitly capable replica packages"""

from collections.abc import Iterator
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Cookie, Depends, Header, Query, Response

from cairndex.api.deps import RegistryDbSession, authorize_library
from cairndex.auth import SESSION_COOKIE
from cairndex.core.errors import NotFoundError
from cairndex.domain.enums import LibraryStatus
from cairndex.ownership.lifecycle import lifecycle
from cairndex.registry import services as registry_service
from cairndex.replicas import service
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.protocol import FieldName, ReplicaError, Token
from cairndex.replicas.schemas import (
    DraftPage,
    DraftRequest,
    HistoryPage,
    ReplicaBundlePage,
    ReplicaStatus,
    SaveReceipt,
    SaveRequest,
)
from cairndex.replicas.store import Store

router = APIRouter(prefix="/libraries/{library_id}/replica", tags=["replicas"])


# Reuse cookie/bearer scoping while omitting the legacy provider-folder lease entirely
def replica_store(
    library_id: str,
    registry: RegistryDbSession,
    session_cookie: Annotated[str | None, Cookie(alias=SESSION_COOKIE)] = None,
    authorization: Annotated[str | None, Header()] = None,
) -> Iterator[Store | CatalogStore]:
    library = registry_service.get_library(registry, library_id)
    if library.status != LibraryStatus.AVAILABLE:
        raise NotFoundError("Library storage is unavailable; restore its mount and retry")
    authorize_library(
        registry,
        library_id=library_id,
        root=Path(library.root_path),
        session_cookie=session_cookie,
        authorization=authorization,
    )
    lifecycle.retain(library_id)
    try:
        store = service.get_store(library)
        registry.commit()  # Release the registry writer before accessing private metadata
        yield store
    finally:
        lifecycle.leave(library_id)


# Legacy metadata endpoints never run against a catalog-capable store
def bundle_store(store: Annotated[Store | CatalogStore, Depends(replica_store)]) -> Store:
    if not isinstance(store, Store):
        raise ReplicaError("This API requires bundle_metadata_v1")
    return store


CommonReplicaStore = Annotated[Store | CatalogStore, Depends(replica_store)]
ReplicaStore = Annotated[Store, Depends(bundle_store)]
Cursor = Annotated[str, Query(max_length=64)]
Limit = Annotated[int, Query(ge=1, le=50)]


# Honest local durability and transport status without a global synced claim
@router.get("/status", response_model=ReplicaStatus)
def status(store: CommonReplicaStore) -> ReplicaStatus:
    return ReplicaStatus.model_validate(store.status())


# Each explicit retry performs one bounded exchange slice
@router.post("/exchange", response_model=ReplicaStatus)
def exchange(library_id: str, store: CommonReplicaStore) -> ReplicaStatus:
    if isinstance(store, Store):
        service.exchange(library_id)
    return ReplicaStatus.model_validate(store.status())


# No catalog scan or complete-history reconstruction on this listing
@router.get("/bundles", response_model=ReplicaBundlePage)
def bundles(store: ReplicaStore, after: Cursor = "", limit: Limit = 30) -> ReplicaBundlePage:
    return ReplicaBundlePage.model_validate(store.bundles(after, limit))


# The explicit basis is mandatory for both ordinary saves and conflict choices
@router.post("/bundles/{bundle_id}/edits", response_model=SaveReceipt)
def save(bundle_id: Token, payload: SaveRequest, store: ReplicaStore) -> SaveReceipt:
    return SaveReceipt(
        event=store.save(bundle_id, payload.changes, payload.operation, resolve=payload.resolve)
    )


# Historical values remain recoverable through a new causally based save
@router.get("/bundles/{bundle_id}/history/{field}", response_model=HistoryPage)
def history(
    bundle_id: Token, field: FieldName, store: ReplicaStore, after: Cursor = "", limit: Limit = 30
) -> HistoryPage:
    return HistoryPage.model_validate(store.history(bundle_id, field, after, limit))


# Drafts stay local and survive process restart or failed exchange
@router.put("/bundles/{bundle_id}/drafts/{draft_id}", status_code=204)
def draft(
    bundle_id: Token, draft_id: Token, payload: DraftRequest, store: ReplicaStore
) -> Response:
    store.draft(draft_id, bundle_id, payload.revision, payload.changes)
    return Response(status_code=204)


# Recovery never silently replaces another editor's unsaved input
@router.get("/bundles/{bundle_id}/drafts", response_model=DraftPage)
def drafts(
    bundle_id: Token, store: ReplicaStore, after: Cursor = "", limit: Limit = 30
) -> DraftPage:
    return DraftPage.model_validate(store.drafts(bundle_id, after, limit))


# Dismiss exactly the acknowledged draft generation after a successful save or explicit discard
@router.delete("/drafts/{draft_id}", status_code=204)
def dismiss(
    draft_id: Token, revision: Annotated[int, Query(ge=1, le=2_000_000_000)], store: ReplicaStore
) -> Response:
    store.dismiss_draft(draft_id, revision)
    return Response(status_code=204)

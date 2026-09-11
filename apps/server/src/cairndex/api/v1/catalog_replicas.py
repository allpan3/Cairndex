"""Shared library-scoped complete catalog workflows backed by private asynchronous jobs"""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Response

from cairndex.api.v1.replicas import replica_store
from cairndex.replicas.catalog import jobs
from cairndex.replicas.catalog.schemas import (
    CatalogDraftRequest,
    CatalogEntity,
    CatalogJob,
    CatalogJobPage,
    CatalogJobRequest,
    CatalogPage,
    Family,
)
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.protocol import ReplicaError, Token
from cairndex.replicas.store import Store

router = APIRouter(prefix="/libraries/{library_id}/replica/catalog", tags=["replica-catalog"])


# Richer catalog routes refuse the bounded protocol-one store before any mutation
def catalog_store(store: Annotated[Store | CatalogStore, Depends(replica_store)]) -> CatalogStore:
    if not isinstance(store, CatalogStore):
        raise ReplicaError("This API requires the complete authored catalog capability")
    return store


Catalog = Annotated[CatalogStore, Depends(catalog_store)]
Cursor = Annotated[str, Query(max_length=256)]
Limit = Annotated[int, Query(ge=1, le=50)]


# File Browser stays within cataloged paths beneath the active library root
@router.get("/files")
def files(
    store: Catalog, directory: str = "", after: str = "", limit: Limit = 30
) -> dict[str, Any]:
    return store.files(directory, after, limit)


# Creation defaults cover every authored column and never sample an owner's existing data
@router.get("/creation/{family}")
def creation(family: Family, store: Catalog) -> dict[str, Any]:
    from cairndex.replicas.catalog.controls import creation as template

    return template(family)


# Family controls preserve exact text for integers and opaque metadata
@router.get("/controls/{family}")
def controls(family: Family, store: Catalog) -> list[dict[str, Any]]:
    from cairndex.replicas.catalog.controls import controls as describe

    return describe(family)


# Catalog lists read only indexed materialization and candidate sets for the requested page
@router.get("/entities/{family}", response_model=CatalogPage)
def entities(
    family: Family, store: Catalog, after: Cursor = "", limit: Limit = 30, deleted: bool = False
) -> CatalogPage:
    return CatalogPage.model_validate(store.entities(family, after, limit, deleted=deleted))


# Explicit identity lookup supports references beyond the currently loaded family page
@router.get("/entities/{family}/{identity}", response_model=CatalogEntity)
def entity(family: Family, identity: str, store: Catalog) -> CatalogEntity:
    return CatalogEntity.model_validate(store.entity(family, identity))


# Queue previews and saves without doing structural work in a request handler
@router.post("/jobs", response_model=CatalogJob, status_code=202)
def enqueue(payload: CatalogJobRequest, store: Catalog) -> CatalogJob:
    return CatalogJob.model_validate(
        jobs.enqueue(store, payload.operation, payload.action, payload.body)
    )


# Paginated durable jobs recover lost queue responses without scanning authored history
@router.get("/jobs", response_model=CatalogJobPage)
def job_list(
    store: Catalog, after: Annotated[int, Query(ge=0)] = 0, limit: Limit = 30
) -> CatalogJobPage:
    return CatalogJobPage.model_validate(jobs.listing(store, after, limit))


# A stable retry identity also identifies the durable local completion receipt
@router.get("/jobs/{operation}", response_model=CatalogJob)
def job(operation: Token, store: Catalog) -> CatalogJob:
    return CatalogJob.model_validate(jobs.job(store, operation))


# Cancellation changes only queued intent and never removes already saved catalog history
@router.delete("/jobs/{operation}", status_code=204)
def cancel(operation: Token, store: Catalog) -> Response:
    jobs.cancel(store, operation)
    return Response(status_code=204)


# History shows rejected values and complete structural choice scope
@router.get("/history")
def history(store: Catalog, unit: str, after: Cursor = "", limit: Limit = 30) -> dict[str, Any]:
    return store.history(unit, after, limit)


# Private drafts retain text, observed bases and retry identities through failed saves
@router.put("/drafts/{owner:path}/{draft_id}", status_code=204)
def draft(owner: str, draft_id: Token, payload: CatalogDraftRequest, store: Catalog) -> Response:
    from cairndex.replicas.catalog.model import value_text

    if len(value_text(payload.body).encode()) > 1024 * 1024:
        raise ReplicaError("Catalog draft exceeds the supported size")
    store.draft(draft_id, owner, payload.revision, payload.body)
    return Response(status_code=204)


# Recovery lists every retained editor draft without merging unsaved text automatically
@router.get("/drafts")
def drafts(store: Catalog, owner: str, after: Cursor = "", limit: Limit = 30) -> dict[str, Any]:
    return store.drafts(owner, after, limit)


# Acknowledged draft generations cannot be resurrected by delayed writes
@router.delete("/drafts/{draft_id}", status_code=204)
def dismiss(
    draft_id: Token, store: Catalog, revision: Annotated[int, Query(ge=1, le=2_000_000_000)]
) -> Response:
    store.dismiss_draft(draft_id, revision)
    return Response(status_code=204)

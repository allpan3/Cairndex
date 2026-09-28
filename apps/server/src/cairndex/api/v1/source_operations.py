"""Authenticated portable source reviews, asynchronous application and recovery."""

from typing import Annotated, Any

from fastapi import APIRouter, Query, Request, Response

from cairndex.api.deps import RegistryDbSession
from cairndex.api.v1.catalog_replicas import Catalog
from cairndex.file_ops.gate import ensure_portable_write_mode
from cairndex.replicas import source_journal as journal
from cairndex.replicas.protocol import Token
from cairndex.replicas.source_journal import SourceAccept, SourceJob, SourcePage, SourceRequest

router = APIRouter(prefix="/libraries/{library_id}/source-operations", tags=["source-operations"])


@router.put("/uploads/{upload}", status_code=201)
async def upload_bytes(
    library_id: str,
    upload: Token,
    request: Request,
    store: Catalog,
    registry: RegistryDbSession,
    size: Annotated[int, Query(ge=0, le=128 * 1024**3)],
) -> dict[str, Any]:
    from pathlib import Path

    from cairndex.registry.services import get_library
    from cairndex.replicas.source_uploads import receive

    ensure_portable_write_mode(registry, library_id)
    root = Path(get_library(registry, library_id).root_path)
    registry.commit()

    def authorize_upload() -> None:
        # Called on the request thread, never from the byte-write thread pool.
        registry.commit()
        registry.expire_all()
        ensure_portable_write_mode(registry, library_id)

    return await receive(store, root, upload, size, request.stream(), authorize_upload)


@router.post("", response_model=SourceJob, status_code=202)
def enqueue(
    library_id: str, payload: SourceRequest, store: Catalog, registry: RegistryDbSession
) -> SourceJob:
    ensure_portable_write_mode(registry, library_id)
    registry.commit()
    return journal.enqueue(store, payload)


@router.get("", response_model=SourcePage)
def listing(
    store: Catalog,
    after: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=50)] = 30,
) -> SourcePage:
    return journal.listing(store, after, limit)


@router.get("/receipts")
def receipts(
    store: Catalog, after: str = "", limit: Annotated[int, Query(ge=1, le=50)] = 30
) -> dict[str, Any]:
    import json

    with store.connection(readonly=True) as db:
        rows = db.execute(
            "SELECT id,raw,state,error FROM source_receipts WHERE id>? ORDER BY id LIMIT ?",
            (after, limit + 1),
        ).fetchall()
    return {
        "items": [
            {
                "id": row["id"],
                "state": row["state"],
                "error": row["error"],
                "receipt": json.loads(row["raw"]) if row["state"] != "invalid" else None,
            }
            for row in rows[:limit]
        ],
        "next_cursor": rows[limit - 1]["id"] if len(rows) > limit else None,
    }


@router.get("/{operation}", response_model=SourceJob)
def job(operation: Token, store: Catalog) -> SourceJob:
    return journal.job(store, operation)


@router.post("/{operation}/accept", response_model=SourceJob, status_code=202)
def accept(
    library_id: str,
    operation: Token,
    payload: SourceAccept,
    store: Catalog,
    registry: RegistryDbSession,
) -> SourceJob:
    ensure_portable_write_mode(registry, library_id)
    registry.commit()
    return journal.accept(store, operation, payload.receipt)


@router.post("/{operation}/retry", response_model=SourceJob, status_code=202)
def retry(
    library_id: str, operation: Token, store: Catalog, registry: RegistryDbSession
) -> SourceJob:
    ensure_portable_write_mode(registry, library_id)
    registry.commit()
    return journal.retry(store, operation)


@router.delete("/{operation}", status_code=204)
def cancel(operation: Token, store: Catalog) -> Response:
    journal.cancel(store, operation)
    return Response(status_code=204)

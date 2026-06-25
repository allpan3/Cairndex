from fastapi import APIRouter, Query, status

from cairndex.api.deps import DbSession, Pagination
from cairndex.api.schemas.common import Page
from cairndex.api.schemas.jobs import JobRead
from cairndex.api.schemas.storage_roots import (
    FastAddRequest,
    FastAddResponse,
    StorageRootCreate,
    StorageRootRead,
    StorageRootUpdate,
)
from cairndex.domain.enums import JobType
from cairndex.scanning.fast_add import fast_add
from cairndex.services import jobs as job_service
from cairndex.services import storage_roots as service

router = APIRouter(prefix="/storage-roots", tags=["storage-roots"])


def _enqueue(db: DbSession, root_id: str, job_type: JobType, payload: dict[str, object]) -> JobRead:
    service.get_storage_root(db, root_id)  # 404 if the root does not exist
    job = job_service.create_job(db, type=job_type, payload={"storage_root_id": root_id, **payload})
    return JobRead.model_validate(job)


@router.post("", response_model=StorageRootRead, status_code=status.HTTP_201_CREATED)
def create_storage_root(payload: StorageRootCreate, db: DbSession) -> StorageRootRead:
    root = service.create_storage_root(
        db,
        name=payload.name,
        canonical_path=payload.canonical_path,
        read_only=payload.read_only,
    )
    return StorageRootRead.model_validate(root)


@router.get("", response_model=Page[StorageRootRead])
def list_storage_roots(db: DbSession, page: Pagination) -> Page[StorageRootRead]:
    roots, next_cursor = service.list_storage_roots(db, limit=page.limit, cursor=page.cursor)
    return Page(
        items=[StorageRootRead.model_validate(r) for r in roots],
        next_cursor=next_cursor,
    )


@router.get("/{root_id}", response_model=StorageRootRead)
def get_storage_root(root_id: str, db: DbSession) -> StorageRootRead:
    return StorageRootRead.model_validate(service.get_storage_root(db, root_id))


@router.patch("/{root_id}", response_model=StorageRootRead)
def update_storage_root(root_id: str, payload: StorageRootUpdate, db: DbSession) -> StorageRootRead:
    root = service.update_storage_root(
        db,
        root_id,
        name=payload.name,
        canonical_path=payload.canonical_path,
        read_only=payload.read_only,
    )
    return StorageRootRead.model_validate(root)


@router.delete("/{root_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_storage_root(root_id: str, db: DbSession) -> None:
    service.delete_storage_root(db, root_id)


# --- Async media jobs (the worker runs them; poll via /api/v1/jobs) ----------
@router.post("/{root_id}/scan", response_model=JobRead, status_code=status.HTTP_202_ACCEPTED)
def scan_root(root_id: str, db: DbSession) -> JobRead:
    return _enqueue(db, root_id, JobType.SCAN, {})


@router.post("/{root_id}/probe", response_model=JobRead, status_code=status.HTTP_202_ACCEPTED)
def probe_root(root_id: str, db: DbSession, reprobe: bool = Query(default=False)) -> JobRead:
    return _enqueue(db, root_id, JobType.PROBE, {"reprobe": reprobe})


@router.post("/{root_id}/thumbnails", response_model=JobRead, status_code=status.HTTP_202_ACCEPTED)
def thumbnails_root(root_id: str, db: DbSession, force: bool = Query(default=False)) -> JobRead:
    return _enqueue(db, root_id, JobType.THUMBNAIL, {"force": force})


@router.post("/{root_id}/fast-add", response_model=FastAddResponse)
def fast_add_files(root_id: str, payload: FastAddRequest, db: DbSession) -> FastAddResponse:
    result = fast_add(
        db,
        root_id,
        paths=payload.paths,
        grouping=payload.grouping,
        bundle_title=payload.bundle_title,
    )
    return FastAddResponse(
        bundles_created=result.bundles_created,
        files_linked=result.files_linked,
        skipped=result.skipped,
    )

from fastapi import APIRouter, status

from cairndex.api.deps import DbSession, Pagination
from cairndex.api.schemas.bundles import (
    BundleCreate,
    BundleFolders,
    BundleRead,
    BundleTags,
    BundleUpdate,
    FileLink,
    FileRead,
    SetIdsRequest,
)
from cairndex.api.schemas.common import Page
from cairndex.services import bundles as service

router = APIRouter(prefix="/bundles", tags=["bundles"])


@router.post("", response_model=BundleRead, status_code=status.HTTP_201_CREATED)
def create_bundle(payload: BundleCreate, db: DbSession) -> BundleRead:
    bundle = service.create_bundle(
        db,
        title=payload.title,
        note=payload.note,
        source_url=payload.source_url,
        rating=payload.rating,
    )
    return BundleRead.model_validate(bundle)


@router.get("", response_model=Page[BundleRead])
def list_bundles(db: DbSession, page: Pagination) -> Page[BundleRead]:
    rows, next_cursor = service.list_bundles(db, limit=page.limit, cursor=page.cursor)
    return Page(items=[BundleRead.model_validate(b) for b in rows], next_cursor=next_cursor)


@router.get("/{bundle_id}", response_model=BundleRead)
def get_bundle(bundle_id: str, db: DbSession) -> BundleRead:
    return BundleRead.model_validate(service.get_bundle(db, bundle_id))


@router.patch("/{bundle_id}", response_model=BundleRead)
def update_bundle(bundle_id: str, payload: BundleUpdate, db: DbSession) -> BundleRead:
    changes = payload.model_dump(exclude_unset=True)
    return BundleRead.model_validate(service.update_bundle(db, bundle_id, changes))


@router.delete("/{bundle_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_bundle(bundle_id: str, db: DbSession) -> None:
    service.delete_bundle(db, bundle_id)


# --- Files -------------------------------------------------------------------
@router.get("/{bundle_id}/files", response_model=list[FileRead])
def list_files(bundle_id: str, db: DbSession) -> list[FileRead]:
    return [FileRead.model_validate(f) for f in service.list_files(db, bundle_id)]


@router.post("/{bundle_id}/files", response_model=FileRead, status_code=status.HTTP_201_CREATED)
def add_file(bundle_id: str, payload: FileLink, db: DbSession) -> FileRead:
    asset_file = service.add_file(
        db,
        bundle_id,
        storage_root_id=payload.storage_root_id,
        relative_path=payload.relative_path,
        role=payload.role,
        media_kind=payload.media_kind,
        display_title=payload.display_title,
        sequence=payload.sequence,
        note=payload.note,
        source_url=payload.source_url,
        mime_type=payload.mime_type,
    )
    return FileRead.model_validate(asset_file)


@router.delete("/{bundle_id}/files/{file_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_file(bundle_id: str, file_id: str, db: DbSession) -> None:
    service.remove_file(db, bundle_id, file_id)


# --- Tag / folder assignment -------------------------------------------------
@router.put("/{bundle_id}/tags", response_model=BundleTags)
def set_tags(bundle_id: str, payload: SetIdsRequest, db: DbSession) -> BundleTags:
    bundle = service.set_bundle_tags(db, bundle_id, payload.ids)
    return BundleTags(bundle_id=bundle.id, tag_ids=[t.id for t in bundle.tags])


@router.put("/{bundle_id}/folders", response_model=BundleFolders)
def set_folders(bundle_id: str, payload: SetIdsRequest, db: DbSession) -> BundleFolders:
    bundle = service.set_bundle_folders(db, bundle_id, payload.ids)
    return BundleFolders(bundle_id=bundle.id, folder_ids=[f.id for f in bundle.folders])

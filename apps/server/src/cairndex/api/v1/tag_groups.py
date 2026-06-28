from fastapi import APIRouter, status

from cairndex.api.deps import LibrarySession, Pagination
from cairndex.api.schemas.common import Page
from cairndex.api.schemas.taxonomy import (
    SetTagsRequest,
    TagGroupCreate,
    TagGroupRead,
    TagGroupTags,
    TagGroupUpdate,
)
from cairndex.services import tag_groups as service

router = APIRouter(prefix="/libraries/{library_id}/tag-groups", tags=["tag-groups"])


@router.post("", response_model=TagGroupRead, status_code=status.HTTP_201_CREATED)
def create_tag_group(payload: TagGroupCreate, db: LibrarySession) -> TagGroupRead:
    return TagGroupRead.model_validate(service.create_tag_group(db, name=payload.name))


@router.get("", response_model=Page[TagGroupRead])
def list_tag_groups(db: LibrarySession, page: Pagination) -> Page[TagGroupRead]:
    rows, next_cursor = service.list_tag_groups(db, limit=page.limit, cursor=page.cursor)
    return Page(items=[TagGroupRead.model_validate(g) for g in rows], next_cursor=next_cursor)


@router.get("/{group_id}", response_model=TagGroupRead)
def get_tag_group(group_id: str, db: LibrarySession) -> TagGroupRead:
    return TagGroupRead.model_validate(service.get_tag_group(db, group_id))


@router.patch("/{group_id}", response_model=TagGroupRead)
def update_tag_group(group_id: str, payload: TagGroupUpdate, db: LibrarySession) -> TagGroupRead:
    return TagGroupRead.model_validate(service.update_tag_group(db, group_id, name=payload.name))


@router.delete("/{group_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_tag_group(group_id: str, db: LibrarySession) -> None:
    service.delete_tag_group(db, group_id)


@router.put("/{group_id}/tags", response_model=TagGroupTags)
def set_group_tags(group_id: str, payload: SetTagsRequest, db: LibrarySession) -> TagGroupTags:
    group = service.set_group_tags(db, group_id, payload.tag_ids)
    return TagGroupTags(group_id=group.id, tag_ids=[t.id for t in group.tags])


@router.get("/{group_id}/tags", response_model=TagGroupTags)
def get_group_tags(group_id: str, db: LibrarySession) -> TagGroupTags:
    group = service.get_tag_group(db, group_id)
    return TagGroupTags(group_id=group.id, tag_ids=[t.id for t in group.tags])

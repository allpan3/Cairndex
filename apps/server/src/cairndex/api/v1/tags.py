from fastapi import APIRouter, status

from cairndex.api.deps import IfMatchVersion, LibrarySession, Pagination
from cairndex.api.schemas.browse import CountsResponse
from cairndex.api.schemas.common import Page
from cairndex.api.schemas.taxonomy import TagCreate, TagRead, TagReorder, TagUpdate
from cairndex.services import browse as browse_service
from cairndex.services import tags as service

router = APIRouter(prefix="/libraries/{library_id}/tags", tags=["tags"])


@router.get("/counts", response_model=CountsResponse)
def tag_counts(db: LibrarySession) -> CountsResponse:
    return CountsResponse(counts=browse_service.tag_counts(db))


@router.put("/reorder", response_model=list[TagRead])
def reorder_tags(payload: TagReorder, db: LibrarySession) -> list[TagRead]:
    """Reorder sibling tags (All Tags drag-reorder). Reorders among siblings
    only — hierarchy ``parent_id`` is never changed."""
    tags = service.reorder_tags(db, parent_id=payload.parent_id, ordered_ids=payload.ordered_ids)
    return [TagRead.model_validate(t) for t in tags]


@router.post("", response_model=TagRead, status_code=status.HTTP_201_CREATED)
def create_tag(payload: TagCreate, db: LibrarySession) -> TagRead:
    tag = service.create_tag(
        db, name=payload.name, parent_id=payload.parent_id, color=payload.color
    )
    return TagRead.model_validate(tag)


@router.get("", response_model=Page[TagRead])
def list_tags(db: LibrarySession, page: Pagination) -> Page[TagRead]:
    rows, next_cursor = service.list_tags(db, limit=page.limit, cursor=page.cursor)
    return Page(items=[TagRead.model_validate(t) for t in rows], next_cursor=next_cursor)


@router.get("/{tag_id}", response_model=TagRead)
def get_tag(tag_id: str, db: LibrarySession) -> TagRead:
    return TagRead.model_validate(service.get_tag(db, tag_id))


@router.patch("/{tag_id}", response_model=TagRead)
def update_tag(
    tag_id: str, payload: TagUpdate, db: LibrarySession, if_match: IfMatchVersion = None
) -> TagRead:
    fields = payload.model_fields_set
    tag = service.update_tag(
        db,
        tag_id,
        name=payload.name,
        parent_id=payload.parent_id,
        set_parent="parent_id" in fields,
        color=payload.color,
        set_color="color" in fields,
        expected_version=if_match,
    )
    return TagRead.model_validate(tag)


@router.delete("/{tag_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_tag(tag_id: str, db: LibrarySession) -> None:
    service.delete_tag(db, tag_id)

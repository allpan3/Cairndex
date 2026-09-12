"""Small library revision read for connected-client refresh and new edit sessions"""

from fastapi import APIRouter
from pydantic import BaseModel

from cairndex.api.deps import LibrarySession
from cairndex.api.metadata import MetadataRoute
from cairndex.metadata.session import read_basis

router = APIRouter(
    prefix="/libraries/{library_id}/metadata", tags=["metadata"], route_class=MetadataRoute
)


# Database-scoped bases are opaque to clients and contain no authored metadata
class MetadataRevision(BaseModel):
    basis: str


# Read two indexed clock rows without enumerating the catalog
@router.get("", response_model=MetadataRevision)
def get_metadata_revision(db: LibrarySession) -> MetadataRevision:
    return MetadataRevision(basis=read_basis(db.connection()))

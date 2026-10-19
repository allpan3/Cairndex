"""Read-only manual suggestions; guarded catalog jobs remain the confirmation path."""

from fastapi import APIRouter, Query

from cairndex.api.schemas.manual_bundling import (
    BundleDraftResponse,
    FileSuggestionsResponse,
    TargetSuggestionsResponse,
)
from cairndex.api.v1.catalog_replicas import Catalog
from cairndex.replicas.catalog import manual_suggestions as suggestions
from cairndex.replicas.protocol import Token

router = APIRouter(
    prefix="/libraries/{library_id}/replica/catalog/manual-bundling", tags=["replica-catalog"]
)


@router.post("/suggest-targets", response_model=TargetSuggestionsResponse)
def targets(payload: suggestions.SeedSelection, store: Catalog) -> TargetSuggestionsResponse:
    with store.connection(readonly=True) as db:
        return TargetSuggestionsResponse.model_validate(
            {"suggestions": suggestions.targets(db, payload)}
        )


@router.post("/suggest-bundle", response_model=BundleDraftResponse)
def draft(payload: suggestions.SeedSelection, store: Catalog) -> BundleDraftResponse:
    with store.connection(readonly=True) as db:
        return BundleDraftResponse.model_validate(suggestions.draft(db, payload))


@router.get("/bundles/{bundle}/suggest-files", response_model=FileSuggestionsResponse)
def files(
    bundle: Token, store: Catalog, limit: int = Query(default=30, ge=1, le=50)
) -> FileSuggestionsResponse:
    with store.connection(readonly=True) as db:
        return FileSuggestionsResponse.model_validate(
            {"suggestions": suggestions.files_for(db, bundle, limit)}
        )

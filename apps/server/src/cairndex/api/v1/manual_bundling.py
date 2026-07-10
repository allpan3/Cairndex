"""Manual bundling assistant API (Unbundled staging follow-up to ADR-0009).

Suggestion endpoints are read-only (generated on dialog open); the ``*/apply``
and create endpoints are the explicit, metadata-only mutations that turn
unbundled (scan-staged provisional) files into confirmed bundles.
"""

from typing import Annotated

from fastapi import APIRouter, Query, status

from cairndex.api.deps import LibrarySession
from cairndex.api.schemas.file_browser import FileBrowserEntryRead, UnbundledFilesPage
from cairndex.api.schemas.manual_bundling import (
    AddFilesRequest,
    BundleDraftResponse,
    CreateBundleFromFilesRequest,
    CreateEmptyBundleRequest,
    FileSuggestionRead,
    FileSuggestionsResponse,
    ManualBundleResultRead,
    ProposedRoleRead,
    SuggestBundleFromFilesRequest,
    SuggestTargetsRequest,
    TargetSuggestionRead,
    TargetSuggestionsResponse,
)
from cairndex.manual_bundling import apply as apply_service
from cairndex.manual_bundling import suggest as suggest_service
from cairndex.services import file_browser as file_browser_service
from cairndex.services.pagination import MAX_LIMIT

router = APIRouter(prefix="/libraries/{library_id}/manual-bundling", tags=["manual-bundling"])


# --- the Unbundled "to-bundle queue" (read-only) -----------------------------
@router.get("/unbundled-files", response_model=UnbundledFilesPage)
def list_unbundled_files(
    db: LibrarySession,
    offset: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = 100,
) -> UnbundledFilesPage:
    """A flat, cross-library page of files awaiting bundling (provisional scan
    rows), shaped like File Browser entries so the Files surface renders them."""
    page = file_browser_service.list_unbundled_files(db, offset=offset, limit=limit)
    return UnbundledFilesPage(
        items=[FileBrowserEntryRead(**vars(e)) for e in page.items],
        total=page.total,
        offset=page.offset,
        limit=page.limit,
    )


# --- suggestions (read-only) -------------------------------------------------
@router.post("/suggest-targets", response_model=TargetSuggestionsResponse)
def suggest_targets(
    payload: SuggestTargetsRequest, db: LibrarySession
) -> TargetSuggestionsResponse:
    """Confirmed bundles the selected unbundled files most likely belong to."""
    results = suggest_service.suggest_target_bundles(
        db, payload.file_ids, relative_paths=payload.relative_paths, limit=payload.limit
    )
    return TargetSuggestionsResponse(
        suggestions=[
            TargetSuggestionRead(
                bundle_id=s.bundle_id, title=s.title, confidence=s.confidence, reason=s.reason
            )
            for s in results
        ]
    )


@router.get("/bundles/{bundle_id}/suggest-files", response_model=FileSuggestionsResponse)
def suggest_files_for_bundle(
    bundle_id: str, db: LibrarySession, limit: int = 30
) -> FileSuggestionsResponse:
    """Unbundled files that most likely belong in ``bundle_id``."""
    results = suggest_service.suggest_unbundled_files_for_bundle(db, bundle_id, limit=limit)
    return FileSuggestionsResponse(suggestions=[_file_read(s) for s in results])


@router.post("/suggest-bundle", response_model=BundleDraftResponse)
def suggest_bundle_from_files(
    payload: SuggestBundleFromFilesRequest, db: LibrarySession
) -> BundleDraftResponse:
    """A proposed title/roles for a seed selection, plus nearby unbundled files."""
    draft = suggest_service.suggest_bundle_from_files(
        db, payload.file_ids, relative_paths=payload.relative_paths, limit=payload.limit
    )
    return BundleDraftResponse(
        proposed_title=draft.proposed_title,
        roles=[
            ProposedRoleRead(
                file_id=r.file_id,
                relative_path=r.relative_path,
                role=r.role,
                sequence=r.sequence,
            )
            for r in draft.roles
        ],
        additional=[_file_read(s) for s in draft.additional],
    )


# --- mutations (explicit, metadata-only) -------------------------------------
@router.post("/add-files", response_model=ManualBundleResultRead)
def add_files_to_bundle(payload: AddFilesRequest, db: LibrarySession) -> ManualBundleResultRead:
    """Fold selected unbundled files into an existing confirmed bundle."""
    result = apply_service.add_unbundled_files_to_bundle(
        db,
        payload.target_bundle_id,
        payload.file_ids,
        relative_paths=payload.relative_paths,
        role_overrides=payload.role_overrides,
    )
    return _result_read(result)


@router.post(
    "/create-bundle", response_model=ManualBundleResultRead, status_code=status.HTTP_201_CREATED
)
def create_bundle_from_files(
    payload: CreateBundleFromFilesRequest, db: LibrarySession
) -> ManualBundleResultRead:
    """Confirm a new bundle from one or more selected unbundled files."""
    result = apply_service.create_bundle_from_unbundled(
        db,
        payload.file_ids,
        relative_paths=payload.relative_paths,
        title=payload.title,
        role_overrides=payload.role_overrides,
    )
    return _result_read(result)


@router.post(
    "/create-empty-bundle",
    response_model=ManualBundleResultRead,
    status_code=status.HTTP_201_CREATED,
)
def create_empty_bundle(
    payload: CreateEmptyBundleRequest, db: LibrarySession
) -> ManualBundleResultRead:
    """Create a confirmed, empty bundle (files added next)."""
    result = apply_service.create_empty_bundle(db, title=payload.title)
    return _result_read(result)


def _file_read(s: suggest_service.FileSuggestion) -> FileSuggestionRead:
    return FileSuggestionRead(
        file_id=s.file_id,
        relative_path=s.relative_path,
        media_kind=s.media_kind,
        confidence=s.confidence,
        reason=s.reason,
    )


def _result_read(result: apply_service.ManualBundleResult) -> ManualBundleResultRead:
    return ManualBundleResultRead(
        bundle_id=result.bundle_id,
        files_added=result.files_added,
        bundles_removed=result.bundles_removed,
        subtitles_linked=result.subtitles_linked,
        created=result.created,
    )

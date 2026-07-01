"""API schemas for the manual bundling assistant (Unbundled staging follow-up).

Suggestions are read-only and generated automatically when a dialog opens; the
apply requests are the explicit, metadata-only mutations. ``role_overrides`` maps
an asset-file id to a chosen :class:`FileRole`, letting the client override the
heuristic's role for any file before applying.
"""

from pydantic import BaseModel, Field

from cairndex.domain.enums import FileRole, MediaKind


# --- suggestion requests -----------------------------------------------------
class SuggestTargetsRequest(BaseModel):
    file_ids: list[str] = Field(min_length=1)
    limit: int = Field(default=10, ge=1, le=50)


class SuggestBundleFromFilesRequest(BaseModel):
    file_ids: list[str] = Field(min_length=1)
    limit: int = Field(default=30, ge=1, le=100)


# --- suggestion responses ----------------------------------------------------
class TargetSuggestionRead(BaseModel):
    bundle_id: str
    title: str | None
    confidence: float
    reason: str


class FileSuggestionRead(BaseModel):
    file_id: str
    relative_path: str
    media_kind: MediaKind
    confidence: float
    reason: str


class ProposedRoleRead(BaseModel):
    file_id: str
    relative_path: str
    role: FileRole
    sequence: int


class TargetSuggestionsResponse(BaseModel):
    suggestions: list[TargetSuggestionRead]


class FileSuggestionsResponse(BaseModel):
    suggestions: list[FileSuggestionRead]


class BundleDraftResponse(BaseModel):
    proposed_title: str
    roles: list[ProposedRoleRead]
    additional: list[FileSuggestionRead]


# --- apply requests ----------------------------------------------------------
class AddFilesRequest(BaseModel):
    target_bundle_id: str
    file_ids: list[str] = Field(min_length=1)
    role_overrides: dict[str, FileRole] | None = None


class CreateBundleFromFilesRequest(BaseModel):
    file_ids: list[str] = Field(min_length=1)
    title: str | None = None
    role_overrides: dict[str, FileRole] | None = None


class CreateEmptyBundleRequest(BaseModel):
    title: str | None = None


# --- apply response ----------------------------------------------------------
class ManualBundleResultRead(BaseModel):
    bundle_id: str
    files_added: int
    bundles_removed: int
    subtitles_linked: int
    created: bool

"""Schemas for library-scoped file operations (fast-add, path suggestions)."""

from pydantic import BaseModel, Field

from cairndex.domain.enums import Grouping


class PathSuggestions(BaseModel):
    """Directory autocompletions for the add-library form (owner setup only)."""

    # The absolute server paths suggested for the typed prefix.
    suggestions: list[str]


class FastAddRequest(BaseModel):
    paths: list[str] = Field(min_length=1)
    grouping: Grouping = Grouping.PER_FILE
    bundle_title: str | None = Field(default=None, max_length=1024)


class FastAddResponse(BaseModel):
    bundles_created: int
    files_linked: int
    skipped: int

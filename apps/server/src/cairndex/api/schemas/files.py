"""Schemas for library-scoped file operations (fast-add).

The add-library form's own helper schemas (path suggestions and the path probe)
live with the registry they belong to, in ``registry.schemas``.
"""

from pydantic import BaseModel, Field

from cairndex.domain.enums import Grouping


class FastAddRequest(BaseModel):
    paths: list[str] = Field(min_length=1)
    grouping: Grouping = Grouping.PER_FILE
    bundle_title: str | None = Field(default=None, max_length=1024)


class FastAddResponse(BaseModel):
    bundles_created: int
    files_linked: int
    skipped: int
    subtitles_linked: int = 0

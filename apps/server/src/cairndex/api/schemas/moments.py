"""Request/response shapes for moments (plan 7).

A moment is a frame when ``end_s`` is null and a range when it is set. The
distinction is the null, not a discriminator field: ``start == end`` would be
neither, and admitting it would need a minimum length to adjudicate.
"""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator


class MomentCreate(BaseModel):
    """Mark a moment on one of the bundle's files.

    ``end_s`` omitted (or null) marks a frame. The service proves ``file_id`` is
    a member of the bundle in the URL; a client cannot file a moment under a
    bundle that does not hold the video.
    """

    file_id: str
    start_s: float = Field(ge=0)
    end_s: float | None = Field(default=None, gt=0)
    comment: str | None = Field(default=None, max_length=2000)
    #: Assigned at creation, so marking-and-tagging is one request rather than
    #: two. These propagate to the bundle exactly as a later assignment does.
    tag_ids: list[str] = Field(default_factory=list)


class MomentUpdate(BaseModel):
    """Move a moment's ends, or rewrite its comment.

    All optional, and the route forwards only explicitly-set fields — so sending
    ``end_s: null`` turns a range back into a frame while omitting it leaves the
    span alone. ``file_id`` is deliberately absent: a moment marked in one video
    is not the same moment in another, so moving it is a delete and a re-mark.
    """

    start_s: float | None = Field(default=None, ge=0)
    end_s: float | None = Field(default=None, gt=0)
    comment: str | None = Field(default=None, max_length=2000)

    @field_validator("start_s")
    @classmethod
    def _start_cannot_be_cleared(cls, value: float | None) -> float | None:
        """Reject an explicit ``start_s: null``.

        Every field here is nullable so that ``end_s`` and ``comment`` can be
        *cleared* — but a moment always has a start, so null is not a value it
        can take. A validator rather than a non-nullable type because omission
        and explicit null have to stay distinguishable: Pydantic does not run
        this on the default, so an omitted field still means "leave it alone".
        """
        if value is None:
            raise ValueError("start_s cannot be cleared; a moment always has a start")
        return value


class MomentRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    bundle_id: str
    file_id: str
    start_s: float
    #: Null for a frame.
    end_s: float | None
    comment: str | None
    #: Inline rather than behind a per-moment ``/tags`` GET the way a bundle's
    #: are: the inspector draws every moment at once, so a request each would be
    #: N+1 on a pane that is docked beside a playing video. Filled by the route.
    tag_ids: list[str] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime
    version: int


class MomentTags(BaseModel):
    """The answer to a tag assignment: what the moment now carries, and what the
    bundle now carries because of it (plan 7 §4.1).

    Both, so the client's bundle chips update from the same answer that changed
    them rather than from a later refetch that can disagree — the reasoning
    ``reorder_bundles`` already uses.
    """

    moment_id: str
    tag_ids: list[str]
    bundle_tag_ids: list[str]

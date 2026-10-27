"""Private paged grouping drafts; acceptance retains the discovery review contract."""

from typing import Annotated, Any, Literal, Self

from fastapi import APIRouter, Query
from pydantic import Field, model_validator

from cairndex.api.v1.catalog_replicas import Catalog
from cairndex.replicas.grouping import pages, storage
from cairndex.replicas.protocol import StrictModel, Token

router = APIRouter(
    prefix="/libraries/{library_id}/replica/discovery/grouping", tags=["replica-grouping"]
)


class GroupingRename(StrictModel):
    action: Literal["rename"]
    node: Token
    title: str = Field(min_length=1, max_length=512)


class GroupingSelect(StrictModel):
    action: Literal["select"]
    selected: bool
    node: Token | None = None
    file: Token | None = None
    nodes: list[Token] | None = Field(default=None, min_length=1, max_length=50)
    folder: str | None = Field(default=None, max_length=4096)
    exclude_additions: bool = False

    @model_validator(mode="after")
    def scope(self) -> Self:
        if sum(value is not None for value in (self.node, self.file, self.nodes)) > 1:
            raise ValueError("Choose suggestions or a file")
        if self.folder is not None and self.node is None:
            raise ValueError("A folder selection must name its suggestion")
        if self.exclude_additions and (self.node is None or self.folder is not None):
            raise ValueError("Choose a collection branch for this selection")
        return self


class GroupingMoveFile(StrictModel):
    action: Literal["move_file"]
    file: Token
    node: Token
    before: Token | None = None


class GroupingReparent(StrictModel):
    action: Literal["reparent"]
    node: Token
    parent: Token | None = None
    collection: Token | None = None
    before: Token | None = None

    @model_validator(mode="after")
    def destination(self) -> Self:
        if self.parent is not None and self.collection is not None:
            raise ValueError("Choose a proposed or existing collection")
        if "parent" not in self.model_fields_set and self.collection is None:
            raise ValueError("Name a destination or explicitly choose the top level")
        return self


class GroupingDestination(StrictModel):
    action: Literal["destination"]
    node: Token
    create_new: bool


class GroupingFolder(StrictModel):
    action: Literal["folder"]
    node: Token
    folder: str = Field(min_length=1, max_length=4096)
    expanded: bool


class GroupingKind(StrictModel):
    action: Literal["kind"]
    node: Token
    kind: Literal["bundle", "container"]


class GroupingStem(StrictModel):
    action: Literal["stem"]
    node: Token
    level: int = Field(ge=0)


class GroupingPrepare(StrictModel):
    action: Literal["prepare"]
    verify_content: bool = False


class GroupingCancelReview(StrictModel):
    action: Literal["cancel_review"]
    review: Token


GroupingIntent = Annotated[
    GroupingRename
    | GroupingSelect
    | GroupingMoveFile
    | GroupingReparent
    | GroupingDestination
    | GroupingFolder
    | GroupingKind
    | GroupingStem
    | GroupingPrepare
    | GroupingCancelReview,
    Field(discriminator="action"),
]


class GroupingCommand(StrictModel):
    operation: Token
    revision: int = Field(ge=1)
    intent: GroupingIntent


@router.get("/workspaces")
def workspaces(
    store: Catalog, after: int | None = None, limit: int = Query(default=20, ge=1, le=50)
) -> dict[str, Any]:
    return storage.workspaces(store, after, limit)


@router.post("/workspaces/{run}", status_code=202)
def open_workspace(run: Token, store: Catalog) -> dict[str, Any]:
    return storage.open_workspace(store, run)


@router.get("/workspaces/{workspace}")
def status(workspace: Token, store: Catalog) -> dict[str, Any]:
    return storage.status(store, workspace)


@router.get("/workspaces/{workspace}/nodes")
def nodes(
    workspace: Token,
    store: Catalog,
    revision: int = Query(ge=1),
    parent: Token | None = None,
    after: int = Query(default=-1, ge=-1),
    limit: int = Query(default=50, ge=1, le=50),
    exclude_additions: bool = False,
) -> dict[str, Any]:
    with store.connection(readonly=True) as db:
        return pages.nodes(
            db, workspace, revision, parent, after, limit, exclude_additions=exclude_additions
        )


@router.get("/workspaces/{workspace}/additions")
def additions(
    workspace: Token,
    store: Catalog,
    revision: int = Query(ge=1),
    after: str = "",
    limit: int = Query(default=50, ge=1, le=50),
    uncertain: bool = False,
) -> dict[str, Any]:
    with store.connection(readonly=True) as db:
        return pages.additions(db, workspace, revision, after, limit, uncertain=uncertain)


@router.get("/workspaces/{workspace}/nodes/{node}/files")
def files(
    workspace: Token,
    node: Token,
    store: Catalog,
    revision: int = Query(ge=1),
    after: int = Query(default=-1, ge=-1),
    limit: int = Query(default=50, ge=1, le=50),
    visible_only: bool = False,
) -> dict[str, Any]:
    with store.connection(readonly=True) as db:
        return pages.files(db, workspace, revision, node, after, limit, visible_only=visible_only)


@router.get("/workspaces/{workspace}/attention")
def attention(
    workspace: Token,
    store: Catalog,
    revision: int = Query(ge=1),
    after: str = "",
    limit: int = Query(default=50, ge=1, le=50),
    exclude_additions: bool = False,
) -> dict[str, Any]:
    with store.connection(readonly=True) as db:
        return pages.attention(
            db, workspace, revision, after, limit, exclude_additions=exclude_additions
        )


@router.get("/workspaces/{workspace}/destinations")
def destinations(
    workspace: Token,
    store: Catalog,
    revision: int = Query(ge=1),
    kind: Literal["bundle", "container"] = "container",
    query: str = Query(default="", max_length=512),
    after: str = "",
    limit: int = Query(default=50, ge=1, le=50),
) -> dict[str, Any]:
    with store.connection(readonly=True) as db:
        return pages.destinations(db, workspace, revision, kind, query, after, limit)


@router.get("/workspaces/{workspace}/nodes/{node}/folders")
def folders(
    workspace: Token,
    node: Token,
    store: Catalog,
    revision: int = Query(ge=1),
    after: str = "",
    limit: int = Query(default=50, ge=1, le=50),
    visible_only: bool = False,
) -> dict[str, Any]:
    with store.connection(readonly=True) as db:
        return pages.folders(db, workspace, revision, node, after, limit, visible_only=visible_only)


@router.get("/workspaces/{workspace}/stems")
def stems(
    workspace: Token,
    store: Catalog,
    revision: int = Query(ge=1),
    after: str | None = None,
    directory: str | None = None,
    limit: int = Query(default=50, ge=1, le=50),
) -> dict[str, Any]:
    with store.connection(readonly=True) as db:
        return pages.stems(db, workspace, revision, after, limit, directory)


@router.post("/workspaces/{workspace}/commands", status_code=202)
def enqueue(workspace: Token, payload: GroupingCommand, store: Catalog) -> dict[str, Any]:
    return storage.enqueue(
        store,
        workspace,
        payload.operation,
        payload.revision,
        payload.intent.model_dump(exclude_unset=True),
    )


@router.get("/commands/{operation}")
def command(operation: Token, store: Catalog) -> dict[str, Any]:
    return storage.command(store, operation)


@router.post("/commands/{operation}/retry", status_code=202)
def retry(operation: Token, store: Catalog) -> dict[str, Any]:
    return storage.retry(store, operation)

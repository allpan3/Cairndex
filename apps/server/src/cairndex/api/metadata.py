"""HTTP transaction boundary for legacy authored metadata and coherent read bases"""

from collections.abc import Callable, Coroutine
from dataclasses import dataclass
from typing import Any

from fastapi import Request, Response
from fastapi.routing import APIRoute
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from cairndex.core.errors import VersionConflictError
from cairndex.grouping.recovery import recover_before_read
from cairndex.metadata.session import (
    BASIS_HEADER,
    OPERATION_HEADER,
    REVIEW_HEADER,
    EditContext,
    EditUnavailable,
    ReplayedEdit,
    begin_edit,
    read_basis,
    save_receipt,
)

# Explicit observational commands do not participate in authored edit conflicts
OBSERVATIONS = {
    "browse_bundles_filtered",
    "mark_bundle_opened",
    "update_bundle_cursor",
    "update_progress",
    "beacon_progress",
    "suggest_targets",
    "suggest_bundle_from_files",
    "enqueue_scan",
    "enqueue_probe",
    "enqueue_thumbnails",
    "enqueue_storyboards",
}
SOURCE_OPERATIONS = {"delete_bundle_with_files"}


# The route owns commit timing; the dependency owns authorization and session cleanup
@dataclass
class MetadataRequest:
    authored: bool
    body: bytes
    session: Session | None = None
    context: EditContext | None = None
    digest: str = ""
    basis: str = ""
    committed: bool = False


# Called after ordinary library/auth/ownership resolution, including by scoped test fixtures
def begin_metadata_request(request: Request, session: Session) -> None:
    state: MetadataRequest | None = getattr(request.state, "metadata_request", None)
    if state is None:
        return
    state.session = session
    session.info.pop("grouping_settlement", None)
    if state.authored:
        state.context, state.digest = begin_edit(
            session,
            basis=request.headers.get(BASIS_HEADER),
            operation=request.headers.get(OPERATION_HEADER),
            review=request.headers.get(REVIEW_HEADER),
            method=request.method,
            path=str(request.url.path) + "?" + str(request.url.query),
            body=state.body,
        )
    else:
        recover_before_read(session)
        # Explicit BEGIN makes the basis and the following reads one SQLite snapshot
        session.connection().exec_driver_sql("BEGIN")
    state.basis = read_basis(session.connection())


# Serialize, receipt and commit before the response is allowed onto the wire
class MetadataRoute(APIRoute):
    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        original = super().get_route_handler()
        authored = (
            bool((self.methods or set()) - {"GET", "HEAD", "OPTIONS"})
            and self.name not in OBSERVATIONS
        )
        if self.name in SOURCE_OPERATIONS:
            return original
        if authored:
            self.openapi_extra = {
                **(self.openapi_extra or {}),
                "parameters": [
                    {
                        "name": name,
                        "in": "header",
                        "required": name != REVIEW_HEADER,
                        "schema": {"type": "string"},
                        "description": description,
                    }
                    for name, description in (
                        (BASIS_HEADER, "Database read basis retained when editing began"),
                        (
                            OPERATION_HEADER,
                            "Stable random identity reused only for an identical retry",
                        ),
                        (REVIEW_HEADER, "Exact unit revisions explicitly reviewed by the owner"),
                    )
                ],
                "responses": {
                    "409": {"description": "Conflicting metadata; keep the draft and review"},
                    "428": {"description": "Client upgrade/edit preconditions required"},
                },
            }

        async def handle(request: Request) -> Response:
            state = MetadataRequest(authored, await request.body() if authored else b"")
            request.state.metadata_request = state
            try:
                response = await original(request)
                if state.session is not None:
                    settling_grouping = "grouping_settlement" in state.session.info
                    if authored:
                        state.basis = save_receipt(
                            state.session,
                            request.headers[OPERATION_HEADER],
                            state.digest,
                            response.status_code,
                            bytes(response.body),
                        )
                    state.session.commit()
                    state.committed = True
                    if settling_grouping:
                        recover_before_read(state.session)
                        state.basis = read_basis(state.session.connection())
                    response.headers[BASIS_HEADER] = state.basis
                return response
            except ReplayedEdit as replay:
                return Response(
                    replay.body,
                    replay.status,
                    media_type="application/json",
                    headers={BASIS_HEADER: replay.basis},
                )
            except Exception as error:
                if state.context and state.context.conflict:
                    raise VersionConflictError(
                        "This metadata changed elsewhere. "
                        "Your proposed edit is retained for review.",
                        details=state.context.conflict,
                    ) from error
                if isinstance(error, DBAPIError):
                    raise EditUnavailable(
                        "The database could not confirm this request. Your draft is retained; "
                        "retry the same request after the database is available."
                    ) from error
                raise

        return handle

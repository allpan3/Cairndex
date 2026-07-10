from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from cairndex.api.schemas.common import ErrorBody
from cairndex.core.errors import (
    AuthRequiredError,
    CapacityError,
    ConflictError,
    DomainError,
    NotFoundError,
    ValidationError,
)

# Domain error -> HTTP status. Anything not listed falls back to 400.
_STATUS_BY_TYPE: list[tuple[type[DomainError], int]] = [
    (NotFoundError, 404),
    (AuthRequiredError, 401),
    (CapacityError, 429),
    (ConflictError, 409),
    (ValidationError, 422),
]


def _status_for(error: DomainError) -> int:
    for error_type, status in _STATUS_BY_TYPE:
        if isinstance(error, error_type):
            return status
    return 400


def register_exception_handlers(app: FastAPI) -> None:
    async def handle_domain_error(_request: Request, exc: Exception) -> JSONResponse:
        assert isinstance(exc, DomainError)
        body = ErrorBody(code=exc.code, message=exc.message)
        return JSONResponse(status_code=_status_for(exc), content=body.model_dump())

    app.add_exception_handler(DomainError, handle_domain_error)

"""Connection-local edit guards and exact transactional request receipts"""

import hashlib
import json
import re
import sqlite3
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import event
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.orm import Session

from cairndex.core.errors import DomainError, VersionConflictError

BASIS_HEADER = "X-Cairndex-Basis"
OPERATION_HEADER = "X-Cairndex-Operation"
REVIEW_HEADER = "X-Cairndex-Review"
BASIS_PATTERN = re.compile(r"^[a-f0-9]{32}:\d+:[a-f0-9]{32}:\d+$")


# Unversioned clients must upgrade before authoring, rather than silently taking precedence
class EditPreconditionRequired(DomainError):
    code = "edit_precondition_required"


# A transient database failure must never be mistaken for an acknowledged save
class EditUnavailable(DomainError):
    code = "edit_unavailable"


# A repeat request returns its original committed response without invoking domain services
@dataclass
class ReplayedEdit(Exception):
    status: int
    body: bytes
    basis: str


# One context belongs to one checked-out connection and is cleared before pool reuse
@dataclass
class EditContext:
    basis: str
    plans_retired: bool = False
    original: dict[str, int] = field(default_factory=dict)
    reviewed: dict[str, int] = field(default_factory=dict)
    conflict: dict[str, Any] | None = None

    # Remember the pre-transaction clock even when this request touches a unit repeatedly
    def record(self, key: str | None, revision: int) -> int:
        if key is not None:
            self.original.setdefault(key, revision)
        return 1

    # Only the reviewed unit can override its opening basis, and only at that exact revision
    def guard(self, key: str | None, revision: int, current: str, proposed: str) -> int:
        if key is None:
            return 1
        self.record(key, revision)
        revision = self.original[key]
        parts = self.basis.split(":")
        baseline = int(parts[1 if key.startswith("main/") else 3])
        retired = self.plans_retired and key.startswith("plans/")
        reviewable = not retired and key.rsplit("/", 1)[-1] not in {
            "$alive",
            "$deleted",
            "$edited",
            "$members",
            "$forest",
            "$order",
            "$plan",
            "bundle_id",
            "relative_path",
            "directory_path",
            "role",
            "sequence",
            "parent_id",
            "sort_order",
        }
        accepted = not retired and (
            reviewable and revision == self.reviewed[key]
            if key in self.reviewed
            else revision <= baseline
        )
        if accepted:
            return 1
        self.conflict = {
            "unit": key,
            "revision": revision,
            "current": json.loads(current),
            "proposed": json.loads(proposed),
            "reviewable": reviewable,
        }
        return 0


# Install guard functions for persistent triggers; non-HTTP writers still advance clocks
def install_connection_guards(engine: Engine) -> None:
    @event.listens_for(engine, "connect")
    def connect(dbapi: sqlite3.Connection, record: Any) -> None:
        record.info["metadata_context"] = None

        def guard(key: str | None, revision: int, current: str, proposed: str) -> int:
            context = record.info.get("metadata_context")
            return context.guard(key, revision, current, proposed) if context else 1

        def remember(key: str | None, revision: int) -> int:
            context = record.info.get("metadata_context")
            return context.record(key, revision) if context else 1

        dbapi.create_function("metadata_guard", 4, guard)
        dbapi.create_function("metadata_record", 2, remember)

    @event.listens_for(engine, "checkin")
    def checkin(_dbapi: object, record: Any) -> None:
        record.info["metadata_context"] = None


# A basis identifies both portable content and the server-local plan incarnation
def read_basis(connection: Connection) -> str:
    values: list[str] = []
    for row in connection.exec_driver_sql(
        "SELECT epoch,revision FROM main.metadata_clock WHERE id=1 "
        "UNION ALL SELECT epoch,revision FROM plans.metadata_clock WHERE id=1"
    ):
        values.extend((row.epoch, str(row.revision)))
    return ":".join(values)


# Reject foreign databases, future revisions and malformed review acknowledgements
def validate_basis(basis: str | None, current: str, review: str | None) -> EditContext:
    if basis is None:
        raise EditPreconditionRequired(
            "This client must be upgraded to save metadata safely. Reload or update the "
            "app; your draft is retained."
        )
    if not BASIS_PATTERN.fullmatch(basis):
        raise EditPreconditionRequired(
            "The edit basis is invalid; reopen the item with an updated client"
        )
    before, now = basis.split(":"), current.split(":")
    if (
        before[0] != now[0]
        or int(before[1]) > int(now[1])
        or (before[2] == now[2] and int(before[3]) > int(now[3]))
    ):
        raise VersionConflictError(
            "This edit belongs to another database or a retired session; the draft is retained"
        )
    reviewed: dict[str, int] = {}
    if review:
        try:
            reviewed = json.loads(review)
            if (
                not isinstance(reviewed, dict)
                or len(reviewed) > 64
                or any(
                    not isinstance(key, str)
                    or len(key) > 256
                    or type(value) is not int
                    or value < 0
                    for key, value in reviewed.items()
                )
            ):
                raise ValueError
        except (ValueError, TypeError) as error:
            raise EditPreconditionRequired(
                "The conflict review is invalid; review the retained draft again"
            ) from error
    return EditContext(basis, plans_retired=before[2] != now[2], reviewed=reviewed)


# Hash the exact request, including its basis and choices; never log authored bytes
def fingerprint(method: str, path: str, body: bytes, basis: str, review: str) -> str:
    return hashlib.sha256(
        b"\0".join(part.encode() for part in (method, path, basis, review)) + b"\0" + body
    ).hexdigest()


# Serialize before checking clocks and before domain services can read stale ORM state
def begin_edit(
    session: Session,
    *,
    basis: str | None,
    operation: str | None,
    review: str | None,
    method: str,
    path: str,
    body: bytes,
) -> tuple[EditContext, str]:
    if not operation or not re.fullmatch(r"[A-Za-z0-9_-]{16,100}", operation):
        raise EditPreconditionRequired(
            "An updated client and a stable edit request identity are required"
        )
    connection = session.connection()
    connection.exec_driver_sql("BEGIN IMMEDIATE")
    current = read_basis(connection)
    if basis and BASIS_PATTERN.fullmatch(basis) and basis.split(":")[0] != current.split(":")[0]:
        raise VersionConflictError("This draft belongs to another database; reopen it for review")
    digest = fingerprint(method, path, body, basis or "", review or "")
    receipt = connection.exec_driver_sql(
        "SELECT fingerprint, status, body, basis FROM metadata_receipts WHERE operation = ?",
        (operation,),
    ).first()
    if receipt:
        if receipt.fingerprint != digest:
            raise VersionConflictError(
                "This request identity was already used for a different edit"
            )
        raise ReplayedEdit(receipt.status, receipt.body, receipt.basis)
    context = validate_basis(basis, current, review)
    connection.info["metadata_context"] = context
    session.info["metadata_edit"] = context
    return context, digest


# Persist the exact response in the same commit as content; retries cannot create duplicates
def save_receipt(session: Session, operation: str, digest: str, status: int, body: bytes) -> str:
    connection = session.connection()
    basis = read_basis(connection)
    connection.exec_driver_sql(
        (
            "INSERT INTO metadata_receipts(operation, fingerprint, status, body, basis) "
            "VALUES (?, ?, ?, ?, ?)"
        ),
        (operation, digest, status, body, basis),
    )
    return basis

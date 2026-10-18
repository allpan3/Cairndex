"""Durable owner-started conversion steps for legacy library folders (ADR-0038)."""

import threading
from pathlib import Path
from typing import Any, cast

from sqlalchemy import CursorResult, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from cairndex.core.config import get_settings
from cairndex.file_ops import smb_transport
from cairndex.registry import services
from cairndex.registry.models import ConversionTask, RegisteredLibrary
from cairndex.replicas.catalog import legacy_conversion
from cairndex.replicas.catalog.legacy_input import METADATA
from cairndex.replicas.protocol import ReplicaError


def authorize_storage(root: Path) -> None:
    """Ask macOS, on this computer's screen, to let the server use the share's saved login."""
    try:
        smb_transport.authorize(root)
    except OSError as error:
        raise ReplicaError(smb_transport.access_message(error)) from None


def enqueue(
    session: Session, root: Path, identity: str, action: str, body: dict[str, Any]
) -> ConversionTask:
    """Queue one step. A repeated identity returns its task; a different reuse fails."""
    if action not in {"inspect", "prepare", "activate", "undo"}:
        raise ReplicaError("Unsupported conversion step")
    attempt = identity if action in {"inspect", "prepare"} else body.get("attempt", "")
    prior = session.get(ConversionTask, identity)
    if prior:
        if (prior.root_path, prior.action, prior.body) != (root.as_posix(), action, body):
            raise ReplicaError("Operation identity was already used for different work")
        return prior
    if action in {"activate", "undo"}:
        prepared = session.scalar(
            select(ConversionTask).where(
                ConversionTask.id == attempt,
                ConversionTask.action == "prepare",
                ConversionTask.state == "succeeded",
                ConversionTask.root_path == root.as_posix(),
            )
        )
        if prepared is None:
            raise ReplicaError("Select a prepared conversion for this folder")
        if prepared.result is None or prepared.result.get("receipt") != body.get("receipt"):
            raise ReplicaError("Review the exact prepared conversion first")
    task = ConversionTask(
        id=identity,
        root_path=root.as_posix(),
        action=action,
        attempt=attempt,
        body=body,
        state="queued",
    )
    session.add(task)
    try:
        session.flush()
    except IntegrityError as error:
        session.rollback()
        raise ReplicaError("A conversion step for this folder is already running") from error
    return task


def queue(
    session: Session, root_path: str, identity: str, action: str, body: dict[str, Any]
) -> ConversionTask:
    """Accept an owner-setup path; content paths remain library-relative."""
    return enqueue(session, services._normalize_root(root_path), identity, action, body)


def retry(session: Session, task: ConversionTask) -> ConversionTask:
    """Retry the exact accepted swap. A preparation needs a fresh attempt."""
    if task.action not in {"activate", "undo"} or task.state not in {"failed", "interrupted"}:
        raise ReplicaError("Prepare or inspect again; only an interrupted swap can be retried")
    task.state, task.error, task.error_code, task.result = "queued", None, None, None
    try:
        session.flush()
    except IntegrityError as error:
        session.rollback()
        raise ReplicaError("A conversion step for this folder is already running") from error
    return task


def _served(session: Session, root: Path) -> RegisteredLibrary | None:
    """The registry row of a converted library that this server may still serve."""
    library = session.scalar(
        select(RegisteredLibrary).where(RegisteredLibrary.root_path == root.as_posix())
    )
    if library is None or library.package_format == "cairndex.library":
        return None
    return library


def execute(session: Session, task: ConversionTask) -> dict[str, Any]:
    root = Path(task.root_path)
    base = get_settings().data_dir.resolve()
    body = task.body
    # End the registry transaction before slow filesystem and validation work
    session.commit()
    if task.action == "inspect":
        return {"inspection": legacy_conversion.inspect(root)}
    if task.action == "prepare":
        return legacy_conversion.prepare(root, base, task.attempt)
    if task.action == "activate":
        prepared = session.get(ConversionTask, task.attempt)
        if prepared is None or prepared.result is None:
            raise ReplicaError("Select a prepared conversion")
        library = session.scalar(
            select(RegisteredLibrary).where(
                RegisteredLibrary.library_uuid == prepared.result["library_uuid"]
            )
        )
        if (
            library is not None
            and library.package_format != "cairndex.library"
            and (
                library.root_path != root.as_posix()
                or not legacy_conversion._converted(root / METADATA, prepared.result["descriptor"])
            )
        ):
            raise ReplicaError("This server already has another converted history for this library")
        session.commit()
        result = legacy_conversion.activate(
            root,
            base,
            task.attempt,
            body["receipt"],
            confirm_stale_lease=body.get("confirm_stale_lease", False),
        )
        library = services.register_converted(session, root)
        return result | {"library_id": library.id}
    if task.action == "undo":
        library = _served(session, root)
        if library is not None and not library.serving_released:
            raise ReplicaError("Release the library on this server before Undo")
        result = legacy_conversion.undo(root, base, task.attempt, body["receipt"])
        services.register_restored(session, root)
        return result
    raise ReplicaError("Unsupported conversion step")


class ConversionWorker:
    """One bounded worker for conversion steps.

    An interrupted activation or Undo continues after a restart: both re-verify
    every reviewed fact and finish the same directory swap. An interrupted
    preparation stops, because a new attempt is cheaper than reviewing a partial one.
    """

    def __init__(self, factory: sessionmaker[Session]) -> None:
        self.factory = factory
        self.stop_event = threading.Event()
        self.thread: threading.Thread | None = None

    def recover_interrupted(self) -> None:
        with self.factory.begin() as session:
            session.execute(
                update(ConversionTask)
                .where(ConversionTask.state == "running", ConversionTask.action != "prepare")
                .values(state="queued")
            )
            session.execute(
                update(ConversionTask)
                .where(ConversionTask.state == "running")
                .where(ConversionTask.action == "prepare")
                .values(
                    state="interrupted",
                    error="Server stopped. The library is unchanged; prepare again.",
                )
            )

    def run_one(self) -> bool:
        with self.factory() as session:
            task = session.scalar(
                select(ConversionTask)
                .where(ConversionTask.state == "queued")
                .order_by(ConversionTask.created_at, ConversionTask.id)
                .limit(1)
            )
            if task is None:
                return False
            claim = cast(
                CursorResult[Any],
                session.execute(
                    update(ConversionTask)
                    .where(ConversionTask.id == task.id, ConversionTask.state == "queued")
                    .values(state="running")
                ),
            )
            session.commit()
            if claim.rowcount != 1:
                return True
            session.refresh(task)
            try:
                task.result = execute(session, task)
                task.state = "succeeded"
            except Exception as error:
                session.rollback()
                task.state = "failed"
                # Never copy storage paths, SQLite values or arbitrary exception text to the API
                # A step the share's saved login stopped tells the owner how to allow it
                problem = smb_transport.access_problem(error)
                task.error_code = None if problem is None else f"storage_{problem}"
                task.error = (
                    smb_transport.access_message(error)
                    if problem
                    else error.message
                    if isinstance(error, ReplicaError)
                    else "Conversion stopped. Check storage and retry this step."
                )
            session.commit()
        return True

    def start(self) -> None:
        self.recover_interrupted()

        def work() -> None:
            while not self.stop_event.is_set():
                if not self.run_one():
                    self.stop_event.wait(0.25)

        self.thread = threading.Thread(target=work, name="library-conversion", daemon=True)
        self.thread.start()

    def stop(self) -> None:
        self.stop_event.set()
        if self.thread:
            self.thread.join()

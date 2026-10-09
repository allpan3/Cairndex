"""Durable, library-scoped administrative work over the private recovery service."""

import threading
from pathlib import Path
from typing import Any, cast

from sqlalchemy import CursorResult, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from cairndex.core.config import get_settings
from cairndex.registry.models import RecoveryTask, RegisteredLibrary
from cairndex.replicas import recovery, recovery_cli
from cairndex.replicas.binding import BindingLock, location, private_path
from cairndex.replicas.protocol import ReplicaError, canonical, checksum


# A client can select only a completed task belonging to this library and authority.
def selected(session: Session, library_id: str, identity: str, action: str) -> RecoveryTask:
    task = session.get(RecoveryTask, identity)
    if (
        not task
        or task.library_id != library_id
        or task.action != action
        or task.state != "succeeded"
    ):
        raise ReplicaError("Select a completed operation for this library")
    return task


def backup_directory(root: Path, identity: str) -> Path:
    settings = get_settings()
    base = settings.data_dir.resolve()
    parent = settings.private_backup_dir or base.with_name(base.name + "-backups")
    return private_path(parent / identity, root)


def enqueue(
    session: Session, library: RegisteredLibrary, identity: str, action: str, body: dict[str, Any]
) -> RecoveryTask:
    descriptor = recovery.descriptor_at(Path(library.root_path)).model_dump(mode="json")
    prior = session.get(RecoveryTask, identity)
    if prior:
        if (prior.library_id, prior.action, prior.body, prior.descriptor) != (
            library.id,
            action,
            body,
            descriptor,
        ):
            raise ReplicaError("Operation identity was already used for different work")
        return prior
    active = session.scalar(
        select(RecoveryTask.id).where(
            RecoveryTask.library_id == library.id, RecoveryTask.state.in_(["queued", "running"])
        )
    )
    if active:
        raise ReplicaError("Wait for the current backup or recovery operation")
    # References are authorized before queueing, and rechecked by the worker.
    if body.get("backup"):
        selected(session, library.id, body["backup"], "backup")
    if body.get("recovery"):
        selected(session, library.id, body["recovery"], "prepare")
    task = RecoveryTask(
        id=identity,
        library_id=library.id,
        action=action,
        body=body,
        descriptor=descriptor,
        state="queued",
    )
    session.add(task)
    try:
        session.flush()
    except IntegrityError as error:
        session.rollback()
        raise ReplicaError(
            "An operation is already active or uses this identity; refresh and retry"
        ) from error
    return task


def execute(session: Session, task: RecoveryTask, library: RegisteredLibrary) -> dict[str, Any]:
    root = Path(library.root_path)
    descriptor = recovery.descriptor_at(root)
    if descriptor.model_dump(mode="json") != task.descriptor:
        raise ReplicaError("Library authority changed; start a new operation")
    base = private_path(get_settings().data_dir.resolve(), root)
    body = task.body
    backup = None
    review = None
    if body.get("backup"):
        reference = selected(session, library.id, body["backup"], "backup")
        if reference.descriptor != task.descriptor:
            raise ReplicaError("Backup authority differs from this library")
        backup = backup_directory(root, reference.id)
    if body.get("recovery"):
        reference = selected(session, library.id, body["recovery"], "prepare")
        if reference.descriptor != task.descriptor or not reference.result:
            raise ReplicaError("Recovery authority differs from this library")
        _, review = recovery.review_at(base, reference.result["id"])
        if review["descriptor"] != task.descriptor:
            raise ReplicaError("Recovery authority changed")
    # End the registry transaction before slow filesystem and validation work.
    released = library.serving_released
    session.commit()
    if task.action == "backup":
        output = backup_directory(root, task.id)
        if output.exists():
            report = recovery.verify_backup(output, descriptor)
            return report | {"receipt": checksum(canonical(report))}
        return recovery.backup(root, base, output)
    if task.action == "verify":
        if backup is None:
            raise ReplicaError("Select a private snapshot")
        return recovery.verify_backup(backup, descriptor)
    if task.action == "prepare":
        if not released:
            raise ReplicaError("Finish Release before preparing recovery")
        # Release is persisted before drain. The process lock proves that a
        # failed or concurrent drain has also stopped using the private store.
        guard = BindingLock(base, descriptor)
        try:
            if (base / "replica-recoveries" / task.id).exists():
                _, report = recovery.review_at(base, task.id)
                if report["descriptor"] != task.descriptor:
                    raise ReplicaError("Recovery authority changed")
                return report | {"receipt": checksum(canonical(report))}
            return recovery.prepare(root, base, backup, recovery_id=task.id)
        finally:
            guard.close()
    if review is None:
        raise ReplicaError("Select a prepared recovery")
    identity = review["id"]
    if task.action == "inspect":
        return recovery_cli.inspect(
            base, identity, body["kind"], body["after"], body["limit"], body["source"]
        ) | {"kind": body["kind"], "source": body["source"]}
    if task.action == "review":
        result = review | {"receipt": checksum(canonical(review))}
        active, _ = location(base, descriptor)
        directory, _ = recovery.review_at(base, identity)
        if active.name == identity:
            result["state"] = "active"
        elif (directory / "cancelled.json").exists():
            result["state"] = "cancelled"
        return result
    if not released:
        raise ReplicaError("Finish Release before changing recovery state")
    if task.action == "activate":
        return recovery.activate(root, base, identity, body["receipt"])
    if task.action == "cancel":
        return recovery.cancel(root, base, identity, body["receipt"])
    if task.action == "retry_job":
        active, _ = location(base, descriptor)
        if active.name != identity:
            raise ReplicaError("Activate the selected recovery before retrying its jobs")
        return recovery_cli.retry_job(root, base, body["job"], body["receipt"])
    raise ReplicaError("Unsupported recovery action")


class RecoveryWorker:
    """One bounded worker; interrupted operations require an explicit new request."""

    def __init__(self, factory: sessionmaker[Session]) -> None:
        self.factory = factory
        self.stop_event = threading.Event()
        self.thread: threading.Thread | None = None

    def recover_interrupted(self) -> None:
        with self.factory.begin() as session:
            session.execute(
                update(RecoveryTask)
                .where(RecoveryTask.state.in_(["queued", "running"]))
                .values(
                    state="interrupted",
                    error="Server stopped. Inspect retained results, then retry explicitly.",
                )
            )

    def run_one(self) -> bool:
        with self.factory() as session:
            task = session.scalar(
                select(RecoveryTask)
                .where(RecoveryTask.state == "queued")
                .order_by(RecoveryTask.created_at, RecoveryTask.id)
                .limit(1)
            )
            if task is None:
                return False
            claim = cast(
                CursorResult[Any],
                session.execute(
                    update(RecoveryTask)
                    .where(RecoveryTask.id == task.id, RecoveryTask.state == "queued")
                    .values(state="running")
                ),
            )
            session.commit()
            if claim.rowcount != 1:
                return True
            session.refresh(task)
            library = session.get(RegisteredLibrary, task.library_id)
            try:
                if library is None:
                    raise ReplicaError("The library is no longer registered")
                task.result = execute(session, task, library)
                task.state = "succeeded"
            except Exception as error:
                session.rollback()
                task.state = "failed"
                # Never copy storage paths, SQLite values or arbitrary exception text to logs/API.
                task.error = (
                    error.message
                    if isinstance(error, ReplicaError)
                    else "Private recovery failed. Original stores remain intact."
                )
            session.commit()
        return True

    def start(self) -> None:
        self.recover_interrupted()

        def work() -> None:
            while not self.stop_event.is_set():
                if not self.run_one():
                    self.stop_event.wait(0.25)

        self.thread = threading.Thread(target=work, name="private-recovery", daemon=True)
        self.thread.start()

    def stop(self) -> None:
        self.stop_event.set()
        if self.thread:
            self.thread.join()

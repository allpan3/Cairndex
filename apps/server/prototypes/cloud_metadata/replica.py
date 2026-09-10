"""Private SQLite outbox and import transactions, confined to marked synthetic sandboxes"""

import json
import os
import sqlite3
from collections.abc import Callable
from pathlib import Path
from typing import Any
from uuid import uuid4

from .merge import View, branch, evaluate, heads, materialize, references, validate_transition
from .protocol import Event, Invalid, decode, digest, encode, make_event, parse_event

MARKER = "cairndex-disposable-cloud-prototype-v1"
MAX_FILES = 1000


# Failpoints exercise transaction boundaries without a real provider or host suspension
def no_fault(point: str) -> None:
    pass


# Only the harness creates empty, explicitly marked disposable roots
# No initializer accepts an existing Cairndex library or silently marks a populated directory
def initialize(root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    if any(root.iterdir()):
        raise Invalid("sandbox must be empty")
    (root / "SYNTHETIC_ONLY").write_text(MARKER)
    (root / "transport").mkdir()
    (root / "transport" / "payloads").mkdir()
    (root / "transport" / "commits").mkdir()
    (root / "media").mkdir()


# A replica owns one private working database; provider delivery only reaches transport
class Replica:
    # Bind storage identity once and reject accidental reattachment under another identity
    def __init__(
        self,
        root: Path,
        replica: str,
        *,
        library: str = "synthetic-library",
        epoch: str = "synthetic-epoch",
        genesis: str | None = None,
        fault: Callable[[str], None] = no_fault,
    ) -> None:
        if (root / "SYNTHETIC_ONLY").read_text() != MARKER or (root / ".cairndex").exists():
            raise Invalid("not a disposable sandbox")
        self.root, self.replica, self.library, self.epoch = root, replica, library, epoch
        self.fault = fault
        self.db = sqlite3.connect(root / "private.db")
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS events (
                id TEXT PRIMARY KEY, manifest BLOB NOT NULL, body BLOB NOT NULL,
                local INTEGER NOT NULL, published INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, body BLOB NOT NULL);
            CREATE TABLE IF NOT EXISTS quarantine (id TEXT PRIMARY KEY, raw BLOB NOT NULL);
        """)
        identity = encode([library, epoch, replica]).decode()
        stored = self.db.execute("SELECT value FROM config WHERE key='identity'").fetchone()
        if stored and stored[0] != identity:
            self.db.close()
            raise Invalid("private replica identity mismatch")
        with self.db:
            self.db.execute("INSERT OR IGNORE INTO config VALUES ('identity', ?)", (identity,))
            self.db.execute("INSERT OR IGNORE INTO config VALUES ('display', '{}')")
            if genesis is not None:
                stored_root = self.db.execute(
                    "SELECT value FROM config WHERE key='genesis'"
                ).fetchone()
                if stored_root and stored_root[0] != genesis:
                    raise Invalid("genesis identity mismatch")
                self.db.execute("INSERT OR IGNORE INTO config VALUES ('genesis', ?)", (genesis,))

    # Closing never publishes content or claims the provider delivered it
    def close(self) -> None:
        self.db.close()

    # Reconstruct the retained causal archive, including rejected active alternatives
    def events(self) -> dict[str, Event]:
        return {
            row[0]: parse_event(row[1], row[2], self.library, self.epoch)
            for row in self.db.execute("SELECT id, manifest, body FROM events")
        }

    # Report causal candidates separately from the last good rendered values
    def view(self) -> View:
        return evaluate(self.events())

    # Persisted presentation survives a crash even while a conflict remains unresolved
    def display(self) -> dict[str, Any]:
        row = self.db.execute("SELECT value FROM config WHERE key='display'").fetchone()
        return dict(json.loads(row[0]))

    # A local draft captures observed ancestry and is never replaced during import
    def draft(self, changes: dict[str, Any]) -> str:
        token = uuid4().hex
        value = {"parents": heads(self.events()), "changes": changes}
        with self.db:
            self.db.execute("INSERT INTO drafts VALUES (?, ?)", (token, encode(value)))
        return token

    # Saving old input preserves its original causal context, exposing a stale-field conflict
    def save_draft(self, token: str) -> str:
        row = self.db.execute("SELECT body FROM drafts WHERE id=?", (token,)).fetchone()
        if row is None:
            raise Invalid("unknown draft")
        draft = decode(row[0])
        # The retained draft doubles as the retry identity after a commit/response crash
        return self.edit(draft["changes"], parents=draft["parents"], operation=token)

    # Touch every edited or newly referenced lifetime to reveal delete/edit conflicts
    def _touch(self, changes: dict[str, Any]) -> dict[str, Any]:
        result = dict(changes)
        entities: set[str] = set()
        for key, value in changes.items():
            if key.startswith("entity/") and not key.endswith("/alive"):
                entities.add(key.split("/")[1])
            entities.update(references(key, value))
        for entity in entities:
            result.setdefault(f"entity/{entity}/alive", True)
        return result

    # Save authored intent, outbox bytes and display atomically
    def edit(
        self,
        changes: dict[str, Any],
        *,
        parents: list[str] | None = None,
        operation: str | None = None,
        resolving: bool = False,
    ) -> str:
        events = self.events()
        touched = self._touch(changes)
        operation = operation or uuid4().hex
        for prior in events.values():
            if (prior.manifest["replica"], prior.manifest["operation"]) == (
                self.replica,
                operation,
            ):
                if prior.changes != touched:
                    raise Invalid("operation identity reused with different intent")
                return prior.id
        if self.db.execute("SELECT value FROM config WHERE key='blocked'").fetchone():
            raise Invalid("compatibility or identity review required; draft retained")
        observed = heads(events) if parents is None else parents
        base = evaluate(branch(events, observed))
        if resolving and any(
            key.endswith("/alive") and key not in changes
            for key in set(touched) & set(base.conflicts)
        ):
            raise Invalid("choose entity lifetime explicitly")
        if not resolving and set(touched) & set(base.conflicts):
            raise Invalid("explicit conflict choice required")
        event = make_event(self.library, self.epoch, self.replica, operation, observed, touched)
        self._check_event(events, event)
        with self.db:
            self._record(event, local=True)
            self._refresh()
            self.fault("local_before_commit")
        self.fault("local_after_commit")
        return event.id

    # A resolution consumes exactly the frontier the review displayed, never unseen edits
    def resolve(self, choices: dict[str, Any], expected: list[str], operation: str) -> str:
        events = self.events()
        for prior in events.values():
            if (prior.manifest["replica"], prior.manifest["operation"]) == (
                self.replica,
                operation,
            ):
                return self.edit(choices, operation=operation, resolving=True)
        if heads(events) != expected:
            raise Invalid("resolution review is stale")
        if not set(choices) & (set(self.view().conflicts) | self.view().references):
            raise Invalid("no reviewed conflict selected")
        return self.edit(choices, parents=expected, operation=operation, resolving=True)

    # Recover a complete causal version for inspection or explicit selective reapplication
    def recover(self, event_id: str) -> View:
        return evaluate(branch(self.events(), [event_id]))

    # Keep one pinned genesis and reject operation forks even if filenames differ
    def _check_event(self, events: dict[str, Event], event: Event) -> None:
        if not event.parents:
            pinned = self.db.execute("SELECT value FROM config WHERE key='genesis'").fetchone()
            if (pinned and pinned[0] != event.id) or (events and event.id not in events):
                raise Invalid("unrelated genesis")
        for prior in events.values():
            if (prior.manifest["replica"], prior.manifest["operation"]) == (
                event.manifest["replica"],
                event.manifest["operation"],
            ) and prior.id != event.id:
                raise Invalid("operation identity fork")
        validate_transition(events, event)

    # Store exact accepted bytes, not only the chosen field values
    def _record(self, event: Event, *, local: bool) -> None:
        if not event.parents:
            self.db.execute("INSERT OR IGNORE INTO config VALUES ('genesis', ?)", (event.id,))
        self.db.execute(
            "INSERT OR IGNORE INTO events VALUES (?, ?, ?, ?, 0)",
            (
                event.id,
                encode(event.manifest),
                encode(event.changes),
                int(local),
            ),
        )

    # Archive and materialized values share one SQLite transaction
    def _refresh(self) -> None:
        display = materialize(self.display(), self.view())
        self.db.execute(
            "UPDATE config SET value=? WHERE key='display'", (encode(display).decode(),)
        )

    # Synchronize the directory entry as well as file bytes on this local filesystem
    def _fsync_dir(self, path: Path) -> None:
        fd = os.open(path, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    # Temp/rename is local crash hygiene; receivers still distrust all provider deliveries
    def _publish_file(self, directory: str, name: str, data: bytes, phase: str) -> None:
        folder = self.root / "transport" / directory
        destination = folder / name
        if destination.exists():
            if destination.read_bytes() != data:
                raise Invalid("immutable destination changed")
            return
        temp = folder / (name + ".partial")
        with temp.open("wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        self.fault(f"publish_{phase}_temp")
        os.replace(temp, destination)
        self._fsync_dir(folder)
        self.fault(f"publish_{phase}_renamed")

    # Retry durable local outbox entries without generating new edits
    def publish(self) -> None:
        for row in self.db.execute(
            "SELECT id, manifest, body, published FROM events WHERE local=1"
        ).fetchall():
            event = parse_event(row[1], row[2], self.library, self.epoch)
            self._publish_file("payloads", event.manifest["payload"] + ".json", row[2], "body")
            self._publish_file("commits", event.id + ".json", row[1], "manifest")
            if not row[3]:
                self.fault("publish_before_mark")
            with self.db:
                self.db.execute("UPDATE events SET published=1 WHERE id=?", (event.id,))

    # Enumerate bounded regular files; a missing/placeholder-like file waits for another pass
    def _files(self, folder: str) -> list[bytes]:
        from .protocol import LIMIT

        result: list[bytes] = []
        paths = sorted((self.root / "transport" / folder).iterdir())
        if len(paths) > MAX_FILES:
            raise Invalid("prototype file budget exceeded")
        for path in paths:
            if path.suffix != ".json" or path.is_symlink():
                continue
            try:
                with path.open("rb") as stream:
                    data = stream.read(LIMIT + 1)
            except OSError:
                continue
            result.append(data)
        return result

    # Validate complete ancestry before import; incomplete bytes never become state
    def receive(self) -> dict[str, str]:
        bodies = {digest(raw): raw for raw in self._files("payloads")}
        report: dict[str, str] = {}
        pending: dict[str, Event] = {}
        for raw in self._files("commits"):
            token = digest(raw)
            try:
                header = decode(raw)
                if not isinstance(header, dict) or not isinstance(header.get("payload"), str):
                    raise Invalid("invalid manifest")
                if (header.get("library"), header.get("epoch")) == (self.library, self.epoch) and (
                    type(header.get("format")) is not int or header.get("format") != 1
                ):
                    with self.db:
                        self.db.execute(
                            "INSERT OR REPLACE INTO config VALUES ('blocked', 'schema')"
                        )
                    raise Invalid("incompatible schema")
                if header["payload"] not in bodies:
                    report[token] = "waiting for complete payload"
                    continue
                pending[token] = parse_event(
                    raw, bodies[header["payload"]], self.library, self.epoch
                )
            except Invalid as error:
                report[token] = str(error)
                with self.db:
                    self.db.execute("INSERT OR IGNORE INTO quarantine VALUES (?, ?)", (token, raw))
        with self.db:
            events = self.events()
            while pending:
                ready = [
                    event for event in pending.values() if all(p in events for p in event.parents)
                ]
                if not ready:
                    report.update({token: "waiting for ancestry" for token in pending})
                    break
                for event in ready:
                    del pending[event.id]
                    if event.id in events:
                        report[event.id] = "duplicate"
                        continue
                    try:
                        self._check_event(events, event)
                    except Invalid as error:
                        if str(error) == "operation identity fork":
                            self.db.execute(
                                "INSERT OR REPLACE INTO config VALUES ('blocked', 'identity')"
                            )
                        report[event.id] = str(error)
                        self.db.execute(
                            "INSERT OR IGNORE INTO quarantine VALUES (?, ?)",
                            (
                                event.id,
                                encode(event.manifest),
                            ),
                        )
                        continue
                    self._record(event, local=False)
                    events[event.id] = event
                    report[event.id] = "accepted"
            self._refresh()
            self.fault("import_before_commit")
        self.fault("import_after_commit")
        return report

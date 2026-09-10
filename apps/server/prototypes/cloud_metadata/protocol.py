"""Bounded, hash-checked immutable generations for a synthetic metadata schema"""

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any

FORMAT = 1
LIMIT = 1024 * 1024
TOKEN = re.compile(r"[a-zA-Z0-9_-]{1,80}\Z")
DIGEST = re.compile(r"[0-9a-f]{64}\Z")


# Reject unrecognized data without executing or partially applying it
class Invalid(ValueError):
    pass


# Canonical bytes define identity independently of filenames and wall clocks
def encode(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


# Hashes detect incomplete or changed bytes, not malicious authorship
def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# Reject duplicate object keys rather than accepting an ambiguous last value
def unique_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise Invalid("duplicate JSON key")
        result[key] = value
    return result


# Bound the wire format before parsing and require canonical encoding
def decode(data: bytes) -> Any:
    if len(data) > LIMIT:
        raise Invalid("artifact too large")
    try:
        value = json.loads(data, object_pairs_hook=unique_pairs)
        if encode(value) != data:
            raise Invalid("noncanonical artifact")
        return value
    except (ValueError, RecursionError, UnicodeError) as error:
        raise Invalid("invalid artifact") from error


# Carry a complete change transaction and its observed causal parents
@dataclass(frozen=True)
class Event:
    id: str
    manifest: dict[str, Any]
    changes: dict[str, Any]

    # Causal order never depends on timestamps or directory order
    @property
    def parents(self) -> list[str]:
        return list(self.manifest["parents"])


# Check the small experiment schema, including indivisible relationship units
def validate_changes(changes: Any) -> None:
    if not isinstance(changes, dict) or not changes or len(changes) > 500:
        raise Invalid("invalid change set")
    for key, value in changes.items():
        parts = key.split("/")
        if not all(TOKEN.fullmatch(part) for part in parts):
            raise Invalid("invalid key")
        if len(parts) == 3 and parts[0] == "entity":
            field = parts[2]
            valid = (
                (field == "alive" and type(value) is bool)
                or (field in {"title", "note"} and isinstance(value, str))
                or (field == "rating" and type(value) is int and 0 <= value <= 10)
                or (field == "path" and isinstance(value, str) and safe_path(value))
            )
            if not valid:
                raise Invalid("unsupported field or value")
            if field != "alive" and changes.get(f"entity/{parts[1]}/alive") is not True:
                raise Invalid("edit must touch entity lifetime")
        elif len(parts) == 3 and parts[0] == "member" and type(value) is bool:
            if value:
                require_alive(changes, parts[1:])
        elif len(parts) == 2 and parts[0] == "order" and value is None:
            continue  # Removing an ordered unit is a retained tombstone
        elif len(parts) == 2 and parts[0] == "order" and isinstance(value, list):
            if not all(isinstance(item, str) and TOKEN.fullmatch(item) for item in value):
                raise Invalid("invalid order")
            if len(set(value)) != len(value):
                raise Invalid("duplicate order member")
            require_alive(changes, [parts[1], *value])
        elif key == "tree/collections" and isinstance(value, dict):
            validate_tree(value)
            require_alive(changes, [item for children in value.values() for item in children])
        else:
            raise Invalid("unsupported conflict unit")


# Source paths are metadata only and cannot escape a hypothetical library root
def safe_path(value: str) -> bool:
    return (
        bool(value)
        and not any(part in {"", ".", ".."} for part in value.split("/"))
        and not any(char in value for char in ("\\", ":", "\x00"))
    )


# Lifetime touches make deletion concurrent with any edit or new reference visible
def require_alive(changes: dict[str, Any], entities: list[str]) -> None:
    if any(changes.get(f"entity/{entity}/alive") is not True for entity in entities):
        raise Invalid("reference must touch entity lifetime")


# A complete ordered forest is one conservative conflict unit
# The reserved root represents the top level and is not an entity
def validate_tree(tree: dict[str, Any]) -> None:
    children: list[str] = []
    if "root" not in tree:
        raise Invalid("missing hierarchy root")
    for parent, entries in tree.items():
        if not TOKEN.fullmatch(parent) or not isinstance(entries, list):
            raise Invalid("invalid hierarchy")
        if not all(isinstance(item, str) and TOKEN.fullmatch(item) for item in entries):
            raise Invalid("invalid child")
        children.extend(entries)
    if "root" in children or len(set(children)) != len(children):
        raise Invalid("duplicate hierarchy child")
    if set(tree) - {"root"} != set(children):
        raise Invalid("missing hierarchy parent")
    seen: set[str] = set()
    pending = ["root"]
    while pending:
        node = pending.pop()
        if node in seen:
            raise Invalid("hierarchy cycle")
        seen.add(node)
        pending.extend(tree[node])
    if seen != set(tree):
        raise Invalid("disconnected hierarchy cycle")


# Produce one bounded generation, not a mutable latest-state file
def make_event(
    library: str,
    epoch: str,
    replica: str,
    operation: str,
    parents: list[str],
    changes: dict[str, Any],
) -> Event:
    body = encode(changes)
    manifest = {
        "format": FORMAT,
        "library": library,
        "epoch": epoch,
        "replica": replica,
        "operation": operation,
        "parents": sorted(set(parents)),
        "payload": digest(body),
        "size": len(body),
    }
    return parse_event(encode(manifest), body, library, epoch)


# Accept only a complete generation with a compatible identity and exact payload
def parse_event(raw: bytes, body: bytes, library: str, epoch: str) -> Event:
    manifest = decode(raw)
    keys = {"format", "library", "epoch", "replica", "operation", "parents", "payload", "size"}
    if not isinstance(manifest, dict) or set(manifest) != keys:
        raise Invalid("invalid manifest")
    if type(manifest["format"]) is not int or manifest["format"] != FORMAT:
        raise Invalid("incompatible schema")
    if manifest["library"] != library or manifest["epoch"] != epoch:
        raise Invalid("foreign library or epoch")
    if not all(
        isinstance(manifest[k], str) and TOKEN.fullmatch(manifest[k])
        for k in ("library", "epoch", "replica", "operation")
    ):
        raise Invalid("invalid identity")
    parents = manifest["parents"]
    if (
        not isinstance(parents, list)
        or len(parents) > 128
        or not all(isinstance(parent, str) and DIGEST.fullmatch(parent) for parent in parents)
        or parents != sorted(set(parents))
    ):
        raise Invalid("invalid parents")
    if type(manifest["size"]) is not int or manifest["size"] != len(body):
        raise Invalid("incomplete payload")
    if manifest["payload"] != digest(body):
        raise Invalid("corrupt payload")
    changes = decode(body)
    validate_changes(changes)
    return Event(digest(raw), manifest, changes)

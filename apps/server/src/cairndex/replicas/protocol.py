"""Strict package capabilities and complete, content-addressed metadata envelopes"""

import hashlib
import json
from typing import Annotated, Any, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from cairndex.core.errors import ConflictError

PACKAGE_FORMAT: Literal["cairndex.replica-library"] = "cairndex.replica-library"
CAPABILITY: Literal["bundle_metadata_v1"] = "bundle_metadata_v1"
MAX_BYTES = 256 * 1024
MAX_CANDIDATES = 128
Token = Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{1,64}$", strict=True)]
Digest = Annotated[str, Field(pattern=r"^[a-f0-9]{64}$", strict=True)]
FieldName = Literal["title", "notes", "rating"]
Value = str | float | list[str] | None


# Unsupported generations never acquire legacy leases or mutate source packages
class ReplicaError(ConflictError):
    code = "replica_conflict"


# Package changes must stop cached legacy engines as well as first-time openers
class PackageFormatError(ConflictError):
    code = "library_format_unsupported"


# Reject extra fields rather than silently losing a future metadata family
class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


# Shared identity binds private storage to one explicitly versioned package history
class PackageIdentity(StrictModel):
    format: Literal["cairndex.replica-library"]
    library_uuid: Token
    display_name: str = Field(min_length=1, max_length=255)
    epoch: Token
    genesis: Digest


# Capabilities identify this bounded workflow, not a promise of full migration support
class Descriptor(PackageIdentity):
    format_version: Literal[1]
    capabilities: list[Literal["bundle_metadata_v1"]] = Field(min_length=1, max_length=1)


# Seeded bundle identities are immutable in this first workflow
class SeedBundle(StrictModel):
    id: Token
    title: str = Field(min_length=1, max_length=500)
    notes: list[Annotated[str, Field(max_length=100_000)]] = Field(
        default_factory=list, max_length=100
    )
    rating: float | None = Field(default=None, ge=0, le=5, multiple_of=0.5)


# Each changed field names exactly the revisions the editor observed
class Change(StrictModel):
    value: Value
    basis: list[Digest] = Field(min_length=1, max_length=MAX_CANDIDATES)


# A transaction edits one existing bundle, preserving all other metadata families
class Edit(StrictModel):
    protocol: Literal[1]
    kind: Literal["edit"]
    library: Token
    epoch: Token
    replica: Token
    operation: Token
    bundle: Token
    changes: dict[FieldName, Change]

    @model_validator(mode="after")
    def valid_changes(self) -> Self:
        """Validate field semantics before durable acceptance"""
        if not self.changes or len(self.changes) > 3:
            raise ValueError("one to three fields required")
        for key, change in self.changes.items():
            value = change.value
            if len(set(change.basis)) != len(change.basis):
                raise ValueError("duplicate basis")
            if key == "title" and not (isinstance(value, str) and 0 < len(value) <= 500):
                raise ValueError("title required")
            if key == "notes" and not (
                isinstance(value, list)
                and len(value) <= 100
                and all(isinstance(note, str) and len(note) <= 100_000 for note in value)
            ):
                raise ValueError("invalid ordered notes")
            if (
                key == "rating"
                and value is not None
                and not (
                    isinstance(value, (int, float))
                    and not isinstance(value, bool)
                    and 0 <= value <= 5
                    and value * 2 == int(value * 2)
                )
            ):
                raise ValueError("rating must use half stars")
        return self


# Larger and richer libraries cannot accidentally enter the incomplete conversion path
class Seed(StrictModel):
    protocol: Literal[1]
    kind: Literal["seed"]
    library: Token
    epoch: Token
    bundles: list[SeedBundle] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def unique_ids(self) -> Self:
        """One stable seed identity per bundle"""
        if len({bundle.id for bundle in self.bundles}) != len(self.bundles):
            raise ValueError("duplicate bundle")
        return self


# Deterministic bytes define event identity without clocks or provider filenames
def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


# Digests detect changed bytes, not malicious access by a cloud-account owner
def checksum(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


# Keep the complete manifest/payload in one bounded envelope for atomic validation
def envelope(body: Seed | Edit) -> tuple[str, bytes]:
    content = body.model_dump(mode="json")
    event_id = checksum(canonical(content))
    raw = canonical({"sha256": event_id, "body": content})
    if len(raw) > MAX_BYTES:
        raise ReplicaError("Metadata transaction exceeds the supported size")
    return event_id, raw


# Reject ambiguous JSON instead of accepting an implicit last-key winner
def _pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in items:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


# A complete hash and strict schema are mandatory even after a local atomic rename
def decode(raw: bytes, descriptor: Descriptor) -> tuple[str, Seed | Edit]:
    if len(raw) > MAX_BYTES:
        raise ReplicaError("Metadata artifact exceeds the supported size")
    try:
        item = json.loads(raw, object_pairs_hook=_pairs)
        if not isinstance(item, dict) or set(item) != {"sha256", "body"}:
            raise ValueError("envelope")
        body = item["body"]
        if not isinstance(body, dict) or canonical(item) != raw:
            raise ValueError("noncanonical")
        if checksum(canonical(body)) != item["sha256"]:
            raise ValueError("checksum")
        if body.get("library") != descriptor.library_uuid or body.get("epoch") != descriptor.epoch:
            raise ReplicaError("Artifact belongs to another library or history epoch")
        if type(body.get("protocol")) is not int or body["protocol"] != 1:
            raise ReplicaError("Metadata protocol requires an upgrade")
        try:
            event: Seed | Edit = (
                Seed.model_validate(body)
                if body.get("kind") == "seed"
                else Edit.model_validate(body)
            )
        except ValidationError as error:
            raise ReplicaError("Unsupported metadata schema; upgrade required") from error
        event_id, expected = envelope(event)
        if expected != raw:
            raise ValueError("noncanonical values")
        if isinstance(event, Seed) and event_id != descriptor.genesis:
            raise ReplicaError("Library genesis identity does not match")
        return event_id, event
    except (
        ValueError,
        TypeError,
        KeyError,
        RecursionError,
        UnicodeError,
        ValidationError,
    ) as error:
        raise ReplicaError("Incomplete or corrupt metadata artifact") from error

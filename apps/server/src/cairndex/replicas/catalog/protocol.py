"""Versioned catalog envelopes with bounded linked payloads and complete activation roots"""

import json
from collections.abc import Iterable, Iterator
from typing import Any, Literal

from pydantic import Field, ValidationError

from cairndex.replicas.catalog.model import normalize_value, validate_unit
from cairndex.replicas.protocol import (
    MAX_BYTES,
    MAX_CANDIDATES,
    Digest,
    PackageIdentity,
    ReplicaError,
    StrictModel,
    Token,
    canonical,
    checksum,
)

CAPABILITIES = ["authored_catalog_v1", "linked_payload_v1", "structural_choices_v1"]
SEGMENT_BYTES = 32 * 1024


# Exact capability and reader gates stop incomplete clients before private-store mutation
class CatalogDescriptor(PackageIdentity):
    format_version: Literal[2]
    protocol_version: Literal[2]
    catalog_version: Literal[1]
    minimum_reader: Literal[2]
    capabilities: list[str]

    # An unknown optional-looking capability cannot silently discard a durable family
    def model_post_init(self, context: Any) -> None:
        if self.capabilities != CAPABILITIES:
            raise ValueError("Unsupported catalog capabilities")


# A root names the complete linked payload and count, never a partially usable seed
class Root(StrictModel):
    protocol: Literal[2]
    kind: Literal["catalog_seed", "catalog_edit"]
    library: Token
    epoch: Token
    replica: Token
    operation: Token
    last: Digest
    parts: int = Field(ge=1, le=10_000_000)
    payload_hash: Digest
    records: int = Field(ge=1, le=100_000_000)
    resolve: bool = False
    recover: bool = False
    parents: list[Digest] = Field(max_length=MAX_CANDIDATES)


# Chunks are bounded and chain-addressed, including when a single forest exceeds an envelope
class Part(StrictModel):
    protocol: Literal[2]
    kind: Literal["catalog_part"]
    library: Token
    epoch: Token
    previous: Digest | None
    index: int = Field(ge=0, le=10_000_000)
    data: str = Field(min_length=1, max_length=SEGMENT_BYTES)


# Empty basis means explicit creation; every existing unit needs its observed revisions
class UnitChange(StrictModel):
    unit: str = Field(min_length=1, max_length=256)
    value: str
    basis: list[Digest] = Field(max_length=MAX_CANDIDATES)
    cohort: Token | None = None

    # Validate values before either private acceptance or immutable publication
    def model_post_init(self, context: Any) -> None:
        self.value = normalize_value(self.value)
        validate_unit(self.unit, self.value)
        if len(self.basis) != len(set(self.basis)):
            raise ValueError("Duplicate observed revision")


# Canonical envelopes have the same immutable publication boundary as protocol one
def envelope(body: Root | Part) -> tuple[str, bytes]:
    content = body.model_dump(mode="json")
    digest = checksum(canonical(content))
    raw = canonical({"sha256": digest, "body": content})
    if len(raw) > MAX_BYTES:
        raise ReplicaError("Catalog envelope exceeds its bounded transport size")
    return digest, raw


# Strict parsing rejects ambiguous JSON, wrong epochs and future protocols without projection
def decode(raw: bytes, descriptor: CatalogDescriptor) -> tuple[str, Root | Part]:
    if len(raw) > MAX_BYTES:
        raise ReplicaError("Catalog artifact exceeds the supported size")
    try:
        item = json.loads(raw)
        if not isinstance(item, dict) or set(item) != {"sha256", "body"}:
            raise ValueError("envelope")
        if canonical(item) != raw or checksum(canonical(item["body"])) != item["sha256"]:
            raise ValueError("checksum")
        body = item["body"]
        if body.get("library") != descriptor.library_uuid or body.get("epoch") != descriptor.epoch:
            raise ReplicaError("Catalog history identity changed; recovery required")
        if type(body.get("protocol")) is not int or body["protocol"] != 2:
            raise ReplicaError("Catalog protocol requires an upgrade")
        model = Part if body.get("kind") == "catalog_part" else Root
        parsed = model.model_validate(body)
        if envelope(parsed)[1] != raw:
            raise ValueError("canonical values")
        if (
            isinstance(parsed, Root)
            and parsed.kind == "catalog_seed"
            and (parsed.resolve or parsed.recover or item["sha256"] != descriptor.genesis)
        ):
            raise ReplicaError("Catalog genesis identity does not match")
        return item["sha256"], parsed
    except ValidationError as error:
        raise ReplicaError("Unsupported catalog schema; upgrade required") from error
    except (ValueError, TypeError, KeyError, AttributeError, UnicodeError, RecursionError) as error:
        raise ReplicaError("Incomplete or corrupt catalog artifact") from error


# Stream arbitrarily large complete seeds through fixed-size canonical transport segments
def payload(
    changes: Iterable[UnitChange],
    *,
    library: str,
    epoch: str,
    replica: str,
    operation: str,
    seed: bool = False,
    resolve: bool = False,
    recover: bool = False,
    parents: list[str] | None = None,
) -> Iterator[tuple[str, bytes]]:
    import hashlib

    digest = hashlib.sha256()
    previous: str | None = None
    index, records = 0, 0
    buffer = b""
    for change in changes:
        line = canonical(change.model_dump()) + b"\n"
        digest.update(line)
        records += 1
        buffer += line
        while len(buffer) >= SEGMENT_BYTES:
            # End each segment on a UTF-8 boundary without splitting a code point
            data = buffer[:SEGMENT_BYTES].decode("utf-8", errors="ignore")
            buffer = buffer[len(data.encode()) :]
            part = Part(
                protocol=2,
                kind="catalog_part",
                library=library,
                epoch=epoch,
                previous=previous,
                index=index,
                data=data,
            )
            previous, raw = envelope(part)
            yield previous, raw
            index += 1
    if buffer:
        part = Part(
            protocol=2,
            kind="catalog_part",
            library=library,
            epoch=epoch,
            previous=previous,
            index=index,
            data=buffer.decode(),
        )
        previous, raw = envelope(part)
        yield previous, raw
        index += 1
    if previous is None:
        raise ReplicaError("A complete nonempty catalog payload is required")
    yield envelope(
        Root(
            protocol=2,
            kind="catalog_seed" if seed else "catalog_edit",
            library=library,
            epoch=epoch,
            replica=replica,
            operation=operation,
            last=previous,
            parts=index,
            payload_hash=digest.hexdigest(),
            records=records,
            resolve=resolve,
            recover=recover,
            parents=parents or [],
        )
    )

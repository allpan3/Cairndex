"""Prepare explicit File Browser selections without publishing staging bundles."""

import json
from pathlib import Path
from typing import Any

from pydantic import Field, field_validator, model_validator

from cairndex.core.paths import normalize_relative_path
from cairndex.replicas import discovery_sources as sources
from cairndex.replicas.catalog.commands import Preview, validate_preview
from cairndex.replicas.catalog.model import key
from cairndex.replicas.catalog.projection import read_row
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.discovery_review import defaults
from cairndex.replicas.protocol import ReplicaError, StrictModel, Token
from cairndex.scanning.media_types import classify, is_hidden_relative_path


class Selection(StrictModel):
    file_ids: list[Token] = Field(default_factory=list, max_length=100)
    relative_paths: list[str] = Field(default_factory=list, max_length=100)

    @field_validator("relative_paths")
    @classmethod
    def paths(cls, paths: list[str]) -> list[str]:
        normalized = [normalize_relative_path(path) for path in paths]
        if any(
            len(path) > 4096 or len(path.split("/")) > 64 or is_hidden_relative_path(path)
            for path in normalized
        ):
            raise ValueError("Choose visible files within the library")
        return normalized

    @model_validator(mode="after")
    def bounded(self) -> "Selection":
        if (
            not 0 < len(self.file_ids) + len(self.relative_paths) <= 100
            or len(set(self.file_ids)) != len(self.file_ids)
            or len(set(self.relative_paths)) != len(self.relative_paths)
        ):
            raise ValueError("Select 1 to 100 distinct files")
        return self


def prepare(store: CatalogStore, root: Path, command: dict[str, Any]) -> dict[str, Any]:
    """Only a worker reads the selected paths; each read samples at most 192 KiB."""
    if store.descriptor.format_version != 3:
        raise ReplicaError("Bundling unlinked paths requires a discovery-capable library")
    selected = Selection(
        file_ids=command.get("files", []), relative_paths=command.get("relative_paths", [])
    )
    observed: list[dict[str, Any]] = []
    fresh = []
    with store.connection() as db:
        for identity in selected.file_ids:
            row = read_row(db, "asset_files", identity)
            if row is None:
                raise ReplicaError("A selected file changed; refresh the files")
            observation = sources.inspect(root, row["relative_path"])
            content = db.execute(
                "SELECT value FROM catalog_units WHERE unit=?",
                (key("asset_files", identity, "$content"),),
            ).fetchone()
            if content and json.loads(content[0]) != observation["evidence"]:
                raise ReplicaError(
                    "A selected file's content changed; review its identity in Update"
                )
            observed.append(observation | {"id": identity})
        for path in selected.relative_paths:
            if not classify(path):
                raise ReplicaError("Choose supported media files to bundle")
            if db.execute(
                "SELECT 1 FROM catalog_paths WHERE family='asset_files' AND path=?", (path,)
            ).fetchone():
                raise ReplicaError("A selected path is already linked; refresh the files")
            observation = sources.inspect(root, path)
            identity = sources.file_id(
                store.descriptor.library_uuid, store.descriptor.epoch, observation
            )
            observed.append(observation | {"id": identity})
            fresh.append(
                defaults(
                    "asset_files",
                    id=identity,
                    bundle_id=None,
                    relative_path=path,
                    original_filename=Path(path).name,
                )
            )
        if len({file["path"] for file in observed}) != len(observed):
            raise ReplicaError("Select each file once")
        builder = Preview(store, db)
        builder.bundle_files(command | {"files": selected.file_ids}, new_files=fresh)
        for file in observed[len(selected.file_ids) :]:
            builder.put(key("asset_files", file["id"], "$content"), file["evidence"])
        receipt = builder.receipt()
        validate_preview(store, db, receipt)
        return receipt | {"sources": observed}


def revalidate(root: Path, observed: list[dict[str, Any]]) -> None:
    for file in observed:
        if sources.inspect(root, file["path"])["generation"] != file["generation"]:
            raise ReplicaError("Selected files changed; refresh and review them again")

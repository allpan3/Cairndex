"""Ordinary bundle-file controls over complete, observed catalog arrangements."""

import json
from pathlib import PurePosixPath
from typing import Any, Literal

from pydantic import Field

from cairndex.core.paths import normalize_relative_path
from cairndex.replicas.catalog.commands import Preview
from cairndex.replicas.catalog.controls import creation
from cairndex.replicas.catalog.model import key
from cairndex.replicas.catalog.projection import read_row
from cairndex.replicas.catalog.selection import observed
from cairndex.replicas.protocol import ReplicaError, StrictModel, Token


class BundleMemberCommand(StrictModel):
    action: Literal["bundle_member"]
    bundle: Token
    change: Literal["move", "remove", "collapse", "expand"]
    entity: Token
    before: Token | None = None
    directory: str | None = Field(default=None, max_length=4096)
    observed: dict[str, list[str]]


def prepare(builder: Preview, raw: dict[str, Any]) -> None:
    """Keep hidden members and dependent metadata in the same guarded preview."""
    command = BundleMemberCommand.model_validate(raw)
    if builder.store.descriptor.format_version != 3:
        raise ReplicaError("Bundle file controls require a current server and library")
    owner = key("asset_bundles", command.bundle, "$members")
    alive = key("asset_bundles", command.bundle, "$alive")
    bases, held = observed(builder, [owner, alive])
    if held or bases != command.observed:
        raise ReplicaError("Bundle files changed; refresh the file list before trying again")
    members = builder.get(owner)
    rows: dict[str, dict[str, Any]] = {}
    for item in members:
        row = read_row(builder.db, item["family"], item["id"])
        if row is None:
            raise ReplicaError("Bundle member is unavailable")
        rows[item["id"]] = row
    selected = next((item for item in members if item["id"] == command.entity), None)
    if selected is None:
        raise ReplicaError("Bundle member is unavailable")
    folders = [item for item in members if item["family"] == "bundle_directory_members"]

    def covered(item: dict[str, Any], folder: dict[str, Any]) -> bool:
        return bool(
            item["family"] == "asset_files"
            and rows[item["id"]]["relative_path"].startswith(
                rows[folder["id"]]["directory_path"] + "/"
            )
        )

    if command.change == "move":
        visible = [item for item in members if not any(covered(item, folder) for folder in folders)]
        visible.sort(key=lambda item: (item["sequence"], item["id"]))
        if selected not in visible or command.before == command.entity:
            raise ReplicaError("Choose a visible row and a distinct destination")
        target = next((item for item in visible if item["id"] == command.before), None)
        if command.before is not None and target is None:
            raise ReplicaError("The destination row is unavailable")
        visible.remove(selected)
        visible.insert(visible.index(target) if target is not None else len(visible), selected)
        ordered = []
        for item in visible:
            ordered.append(item)
            if item["family"] == "bundle_directory_members":
                ordered.extend(
                    sorted(
                        (member for member in members if covered(member, item)),
                        key=lambda member: (member["sequence"], member["id"]),
                    )
                )
        builder.put(owner, [item | {"sequence": index} for index, item in enumerate(ordered)])
    elif command.change == "collapse":
        if selected["family"] != "asset_files" or not command.directory:
            raise ReplicaError("Choose a file in a non-root directory")
        directory = normalize_relative_path(command.directory).rstrip("/")
        if not directory or not rows[command.entity]["relative_path"].startswith(directory + "/"):
            raise ReplicaError("The selected file is no longer in this directory")
        # As in the earlier application, directory members may not overlap across bundles.
        for (raw_folder,) in builder.db.execute(
            "SELECT body FROM catalog_rows WHERE family='bundle_directory_members'"
        ):
            other = json.loads(raw_folder)["directory_path"]
            if (
                other == directory
                or other.startswith(directory + "/")
                or directory.startswith(other + "/")
            ):
                raise ReplicaError("This directory overlaps an existing folder row")
        group = [
            item
            for item in members
            if item["family"] == "asset_files"
            and rows[item["id"]]["relative_path"].startswith(directory + "/")
        ]
        row = {
            field: json.loads(value)
            for field, value in creation("bundle_directory_members")["cells"].items()
        }
        row |= {
            "bundle_id": command.bundle,
            "directory_path": directory,
            "sequence": min(item["sequence"] for item in group),
        }
        builder.create("bundle_directory_members", row)
    elif command.change == "expand":
        if selected["family"] != "bundle_directory_members":
            raise ReplicaError("Choose a folder row to expand")
        builder.delete("bundle_directory_members", command.entity)
    else:
        if selected["family"] != "asset_files":
            raise ReplicaError("Expand the folder before removing individual files")
        # A subtitle pair cannot follow one file into a different bundle.
        for (source,) in builder.db.execute(
            "SELECT source FROM catalog_references WHERE target=?",
            (f"asset_files/{command.entity}",),
        ).fetchall():
            family, identity = source.split("/", 1)
            track = read_row(builder.db, family, identity) if family == "subtitle_tracks" else None
            if track and len({track["video_file_id"], track["source_file_id"]} - {None}) > 1:
                builder.delete(family, identity)
        file = rows[command.entity]
        row = {
            field: json.loads(value) for field, value in creation("asset_bundles")["cells"].items()
        }
        row |= {
            "title": PurePosixPath(file["original_filename"]).stem,
            "grouping_state": "PROVISIONAL",
            "grouping_source": "SCAN_SUGGESTION",
        }
        builder.create("asset_bundles", row)
        builder.transfer(command.bundle, row["id"], [f"asset_files/{command.entity}"])
        for folder in folders:
            if covered(selected, folder) and not any(
                covered(item, folder) for item in members if item != selected
            ):
                builder.delete("bundle_directory_members", folder["id"])
    builder.put(alive, True)

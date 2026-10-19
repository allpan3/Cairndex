"""Ordinary Smart Collection edits retain the bases displayed when the editor opened."""

from typing import TYPE_CHECKING, Any

from cairndex.replicas.catalog.model import key
from cairndex.replicas.catalog.projection import read_row
from cairndex.replicas.protocol import ReplicaError

if TYPE_CHECKING:
    from cairndex.replicas.catalog.commands import Preview


def prepare(builder: "Preview", command: dict[str, Any]) -> None:
    identity, deleting = command["entity"], command.get("delete", False)
    if not isinstance(deleting, bool) or set(command) - {
        "action",
        "entity",
        "delete",
        "observed",
        "name",
        "filter_json",
    }:
        raise ReplicaError("Invalid Smart Collection operation")
    row = read_row(builder.db, "smart_folders", identity)
    if row is None:
        raise ReplicaError("Smart Collection is unavailable; reopen it")
    units = (
        {
            item[0]
            for item in builder.db.execute(
                "SELECT unit FROM catalog_units WHERE family='smart_folders' AND entity=?",
                (identity,),
            )
        }
        if deleting
        else {
            key("smart_folders", identity, column)
            for column in ("$alive", "name", *(("$filter",) if "filter_json" in command else ()))
        }
    )
    observed = command["observed"]
    if (
        set(observed) != units
        or any(
            set(observed[unit]) != {tip["event"] for tip in builder.store.tips(builder.db, unit)}
            for unit in units
        )
        or builder.db.execute(
            "SELECT 1 FROM catalog_holds h JOIN catalog_units u ON u.unit=h.unit "
            "WHERE u.family='smart_folders' AND u.entity=? LIMIT 1",
            (identity,),
        ).fetchone()
    ):
        raise ReplicaError("Smart Collection changed; reopen it or review metadata")
    if deleting:
        builder.delete("smart_folders", identity)
        return
    name = command["name"]
    if not isinstance(name, str) or not name.strip():
        raise ReplicaError("Smart Collection needs a name")
    builder.put(key("smart_folders", identity, "name"), name.strip())
    if "filter_json" in command:
        builder.put(
            key("smart_folders", identity, "$filter"),
            {
                "filter_version": 1,
                "filter_json": command["filter_json"],
            },
        )

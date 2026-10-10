"""Per-serving-instance credentials outside replica stores and portable history."""

import base64
from pathlib import Path
from typing import Any

from cairndex.core.config import get_settings
from cairndex.registry import library_package as pkg
from cairndex.replicas.binding import private_path, read_json, write_json
from cairndex.replicas.protocol import ReplicaError


def path_for(root: Path) -> Path:
    descriptor = pkg.read_manifest(root).replica
    if descriptor is None:
        raise ValueError("Private access settings require a portable library")
    return private_path(
        get_settings().data_dir.resolve() / "library-access" / f"{descriptor.library_uuid}.json",
        root,
    )


def read(root: Path, library_uuid: str | None = None) -> dict[str, Any] | None:
    if library_uuid is None:
        path = path_for(root)
    else:
        import re

        if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", library_uuid):
            raise ValueError("Invalid registered library identity")
        path = private_path(
            get_settings().data_dir.resolve() / "library-access" / f"{library_uuid}.json", root
        )
    if not path.exists() and not path.is_symlink():
        return None
    try:
        record = read_json(path)
        descriptor = pkg.read_manifest(root).replica if library_uuid is None else None
        if (
            set(record) != {"version", "descriptor", "auth"}
            or record["version"] != 1
            or (
                descriptor is not None
                and record["descriptor"] != descriptor.model_dump(mode="json")
            )
            or (
                library_uuid is not None
                and record["descriptor"].get("library_uuid") != library_uuid
            )
        ):
            raise ValueError("Private access authority changed")
        auth = record["auth"]
        if auth is not None and (
            not isinstance(auth, dict)
            or set(auth) != {"scheme", "iterations", "salt", "hash"}
            or auth["scheme"] != "pbkdf2_sha256"
            or type(auth["iterations"]) is not int
            or not 1 <= auth["iterations"] <= 10_000_000
            or len(base64.b64decode(auth["salt"], validate=True)) != 16
            or len(base64.b64decode(auth["hash"], validate=True)) != 32
        ):
            raise ValueError("Private access record is invalid")
        return auth
    except (ReplicaError, AttributeError, TypeError) as error:
        raise ValueError("Private access configuration requires recovery") from error


def write(root: Path, auth: dict[str, Any] | None) -> None:
    path = path_for(root)
    descriptor = pkg.read_manifest(root).replica
    assert descriptor is not None
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    write_json(
        path,
        {"version": 1, "descriptor": descriptor.model_dump(mode="json"), "auth": auth},
        replace=True,
    )

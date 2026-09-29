"""Exercise portable HTTP state on an explicitly supplied disposable deployment."""

from __future__ import annotations

import argparse
import hashlib
import http.cookiejar
import json
import struct
import time
import urllib.error
import urllib.request
import zlib
from pathlib import Path
from typing import Any
from uuid import uuid4


class Client:
    def __init__(self, url: str) -> None:
        self.url = url.rstrip("/") + "/api/v1"
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())
        )

    def request(
        self,
        path: str,
        body: Any = None,
        *,
        method: str | None = None,
        status: int = 200,
    ) -> Any:
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(
            self.url + path,
            data=data,
            method=method,
            headers={"Content-Type": "application/json"},
        )
        try:
            response = self.opener.open(request, timeout=30)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw = response.read()
            assert response.status == status, (path, response.status, raw.decode())
            return json.loads(raw) if raw else None

    def wait(self, path: str, field: str = "state", expected: Any = "succeeded") -> Any:
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            row = self.request(path)
            if row.get(field) == expected:
                return row
            assert row.get("state") not in {"failed", "cancelled", "interrupted"}, row
            time.sleep(0.1)
        raise AssertionError(("Operation timed out", path, row))


def source(client: Client, base: str, operation: str, **intent: Any) -> Any:
    path = base + "/source-operations"
    client.request(path, {"operation": operation, **intent}, status=202)
    review = client.wait(path + "/" + operation, expected="prepared")
    client.request(path + "/" + operation + "/accept", {"receipt": review["receipt"]}, status=202)
    return client.wait(path + "/" + operation)


def recovery(client: Client, base: str, action: str, **body: Any) -> Any:
    path = base + "/private-recovery/tasks"
    row = client.request(path, {"operation": uuid4().hex, "action": action, **body}, status=202)
    return client.wait(path + "/" + row["id"])


def catalog_review(client: Client, base: str, root: Path) -> str:
    """Create one generated image, accept Update, and retain both title branches."""

    def chunk(kind: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
        )

    image = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 4, 4, 8, 2, 0, 0, 0))
    image += chunk(b"IDAT", zlib.compress((b"\x00" + b"\x80\x40\x20" * 4) * 4)) + chunk(
        b"IEND", b""
    )
    (root / "sample.png").write_bytes(image)
    discovery = base + "/replica/discovery"
    client.request(discovery + "/runs", {"operation": "qualification-update"}, status=202)
    client.wait(discovery + "/status")
    candidate = client.request(discovery + "/candidates")["items"][0]
    client.request(
        discovery + "/reviews",
        {"operation": "qualification-review", "candidate": candidate["id"]},
        status=202,
    )
    review_path = discovery + "/reviews/qualification-review"
    review = client.wait(review_path, expected="ready")
    client.request(review_path + "/accept", {"receipt": review["receipt"]}, status=202)
    client.wait(review_path, expected="applied")
    catalog = base + "/replica/catalog"
    page = client.request(catalog + "/bundles/browse", {"limit": 10})
    assert page["total"] == 1
    identity = page["items"][0]["id"]
    entity_path = catalog + "/entities/asset_bundles/" + identity
    original = client.request(entity_path)

    def save(entity: Any, title: str, operation: str, resolve: bool = False) -> None:
        body = {
            "changes": [
                {
                    "unit": entity["fields"][field]["unit"],
                    "basis": entity["fields"][field]["basis"],
                    "value": json.dumps(value),
                }
                for field, value in (("title", title), ("$alive", True))
            ],
            "parents": entity["parents"],
            "resolve": resolve,
            "recover": False,
        }
        client.request(
            catalog + "/jobs", {"operation": operation, "action": "save", "body": body}, status=202
        )
        client.wait(catalog + "/jobs/" + operation)

    save(original, "Synthetic Amber", "title-amber")
    save(original, "Synthetic Blue", "title-blue")
    conflict = client.request(entity_path)
    assert len(conflict["fields"]["title"]["candidates"]) == 2
    save(conflict, "Synthetic reviewed title", "title-choice", True)
    resolved = client.request(entity_path)
    assert not resolved["has_conflicts"]
    assert json.loads(resolved["fields"]["title"]["value"]) == "Synthetic reviewed title"
    return identity


def run(url: str, root: Path, receipt: Path, phase: str) -> None:
    client = Client(url)
    if phase != "initial":
        saved = json.loads(receipt.read_text())
        base = saved["base"]
        client.request(base + "/replica/status", status=401)
        client.request(base + "/auth/unlock", {"passphrase": "Synthetic qualification guard"})
        client.wait(base + "/replica/status", "ready", True)
        assert client.request(base + "/source-operations/undo-trash")["state"] == "succeeded"
        assert (
            hashlib.sha256((root / "folder/moved.txt").read_bytes()).hexdigest() == saved["digest"]
        )
        assert client.request(base + "/replica/catalog/drafts?owner=qualification")["items"]
        saved[phase] = "passed"
        receipt.write_text(json.dumps(saved, indent=2))
        print(phase + ": access, source receipt, bytes and draft survived")
        return
    assert root.is_dir() and not any(root.iterdir()), "Use a fresh empty disposable mount"
    library = client.request(
        "/libraries/create",
        {"display_name": "Synthetic qualification", "root_path": "/libraries/main"},
        status=201,
    )
    base = "/libraries/" + library["id"]
    client.wait(base + "/replica/status", "ready", True)
    catalog_review(client, base, root)
    (root / "original.txt").write_bytes(b"synthetic original bytes")
    (root / "replacement.txt").write_bytes(b"synthetic replacement bytes")
    (root / "folder").mkdir()
    client.request(
        base + "/source-operations",
        {
            "operation": "disabled-copy",
            "action": "copy",
            "source": "original.txt",
            "destination": "copy.txt",
        },
        status=403,
    )
    client.request(base + "/write-mode", {"enabled": True}, method="PUT")
    result = source(
        client,
        base,
        "copy",
        action="copy",
        source="original.txt",
        destination="copy.txt",
    )
    identity = result["review"]["output_id"]
    for operation, action, old, new in (
        ("rename", "rename", "copy.txt", "renamed.txt"),
        ("move", "move", "renamed.txt", "folder/moved.txt"),
    ):
        result = source(client, base, operation, action=action, source=old, destination=new)
        assert result["review"]["output_id"] == identity
    source(
        client,
        base,
        "replace",
        action="copy",
        source="replacement.txt",
        destination="folder/moved.txt",
        collision="replace",
    )
    source(client, base, "undo-replace", action="undo", prior="replace")
    source(client, base, "trash", action="trash", source="folder/moved.txt")
    source(client, base, "undo-trash", action="undo", prior="trash")
    assert (root / "folder/moved.txt").read_bytes() == b"synthetic original bytes"
    # An arrival after review must survive, even when it occupies the exact target.
    path = base + "/source-operations/occupied"
    client.request(
        base + "/source-operations",
        {
            "operation": "occupied",
            "action": "copy",
            "source": "original.txt",
            "destination": "occupied.txt",
        },
        status=202,
    )
    review = client.wait(path, expected="prepared")
    (root / "occupied.txt").write_bytes(b"synthetic new arrival")
    client.request(path + "/accept", {"receipt": review["receipt"]}, status=202)
    client.wait(path, expected="interrupted")
    assert (root / "occupied.txt").read_bytes() == b"synthetic new arrival"
    assert (root / "original.txt").read_bytes() == b"synthetic original bytes"
    client.request(
        base + "/replica/catalog/drafts/qualification/retained",
        {"revision": 1, "body": {"text": "Synthetic retained draft"}},
        method="PUT",
        status=204,
    )
    client.request(
        base + "/auth/settings",
        {"passphrase": "Synthetic qualification guard"},
        method="PUT",
    )
    client.request(base + "/auth/lock", method="POST")
    for path in ("/replica/status", "/source-operations", "/private-recovery/tasks"):
        client.request(base + path, status=401)
    client.request(base + "/auth/unlock", {"passphrase": "wrong"}, status=401)
    client.request(base + "/auth/unlock", {"passphrase": "Synthetic qualification guard"})
    snapshot = recovery(client, base, "backup")
    recovery(client, base, "verify", backup=snapshot["id"])
    client.request(base + "/ownership/release", method="POST")
    client.request(base + "/replica/status", status=409)
    prepared = recovery(client, base, "prepare", backup=snapshot["id"])
    review = recovery(client, base, "review", recovery=prepared["id"])
    recovery(
        client,
        base,
        "activate",
        recovery=prepared["id"],
        receipt=review["result"]["receipt"],
    )
    client.request(base + "/ownership/reopen", method="POST")
    client.wait(base + "/replica/status", "ready", True)
    assert not list(root.rglob("*.db*")), "Private database entered the shared package"
    receipt.write_text(
        json.dumps(
            {
                "base": base,
                "initial": "passed",
                "digest": hashlib.sha256((root / "folder/moved.txt").read_bytes()).hexdigest(),
            },
            indent=2,
        )
    )
    print(
        "initial: source identities, occupied target, access, snapshot, Release and recovery passed"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True)
    parser.add_argument(
        "--root",
        type=Path,
        required=True,
        help="Host path of a fresh synthetic /libraries/main mount",
    )
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--phase", choices=("initial", "restart", "abrupt-exit"), default="initial")
    args = parser.parse_args()
    run(args.url, args.root, args.receipt, args.phase)

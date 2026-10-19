"""Validate retained editable graphs and operation receipts before private recovery."""

import json
import sqlite3

from cairndex.core.paths import normalize_relative_path
from cairndex.replicas.discovery_validation import observation, references
from cairndex.replicas.protocol import ReplicaError


def validate(db: sqlite3.Connection) -> None:
    for work in db.execute("SELECT * FROM grouping_workspaces"):
        workspace = work["id"]
        if (
            work["state"] not in {"building", "ready", "editing"}
            or work["phase"]
            not in {
                "nodes",
                "files",
                "folders",
                "reasons",
                "ready",
                "roles",
                "regroup",
                "export",
                "verification",
                "accepted_files",
                "accepted_nodes",
                "accepted_roles",
            }
            or work["revision"] < 0
            or min(work["files"], work["selected"], work["bundles"]) < 0
            or work["selected"] > work["files"]
        ):
            raise ReplicaError("Invalid private grouping workspace")
        references(db, json.loads(work["parents"]))
        if work["accepting"]:
            review = db.execute(
                "SELECT c.body FROM discovery_reviews r JOIN discovery_candidates c "
                "ON c.id=json_extract(r.intent,'$.candidate') WHERE r.id=?",
                (work["accepting"],),
            ).fetchone()
            if not review or json.loads(review[0]).get("workspace") != workspace:
                raise ReplicaError("Private grouping review is missing its original snapshot")
        if (
            db.execute(
                "SELECT 1 FROM grouping_nodes n LEFT JOIN grouping_nodes p ON "
                "p.workspace=n.workspace "
                "AND p.id=n.parent WHERE n.workspace=? AND n.parent IS NOT NULL "
                "AND (p.id IS NULL OR p.kind<>'container') LIMIT 1",
                (workspace,),
            ).fetchone()
            and work["phase"] != "nodes"
        ):
            raise ReplicaError("Private grouping draft is missing its logical parent")
        if db.execute(
            "WITH RECURSIVE chain(origin,id) AS (SELECT id,parent FROM grouping_nodes WHERE "
            "workspace=? "
            "UNION SELECT c.origin,n.parent FROM chain c JOIN grouping_nodes n "
            "ON n.workspace=? AND n.id=c.id) SELECT 1 FROM chain WHERE origin=id LIMIT 1",
            (workspace, workspace),
        ).fetchone():
            raise ReplicaError("Private grouping draft contains a cycle")
        if work["state"] == "ready":
            actual = tuple(
                db.execute(
                    "SELECT count(*),coalesce(sum(selected),0),count(DISTINCT node) "
                    "FROM grouping_files WHERE workspace=?",
                    (workspace,),
                ).fetchone()
            )
            if actual != tuple(work[name] for name in ("files", "selected", "bundles")):
                raise ReplicaError("Private grouping draft has inconsistent selection counts")
    for node in db.execute("SELECT * FROM grouping_nodes"):
        if (
            node["kind"] not in {"bundle", "container"}
            or node["context"] not in (0, 1)
            or node["roles_dirty"] not in (0, 1)
            or not node["title"].strip()
            or node["position"] < 0
            or not 0 <= node["confidence"] <= 1
            or node["directory"]
            and normalize_relative_path(node["directory"]) != node["directory"]
        ):
            raise ReplicaError("Invalid private grouping suggestion")
        if node["context"] and (node["kind"] != "container" or not node["collection"]):
            raise ReplicaError("Private collection context is inconsistent")
        if node["collection_basis"]:
            for basis in json.loads(node["collection_basis"]).values():
                references(db, basis)
    for file in db.execute("SELECT * FROM grouping_files"):
        body = json.loads(file["body"])
        observation(body)
        if (
            file["id"] != body["id"]
            or file["path"] != body["path"]
            or file["directory"] != file["path"].rpartition("/")[0]
            or file["selected"] not in (0, 1)
            or file["sequence"] < 0
            or not db.execute(
                "SELECT 1 FROM grouping_nodes WHERE workspace=? AND id=? AND kind='bundle'",
                (file["workspace"], file["node"]),
            ).fetchone()
        ):
            raise ReplicaError("Private grouping file is inconsistent")
        if body.get("staged"):
            for basis in body["staged"]["bases"].values():
                references(db, basis)
    for folder in db.execute("SELECT * FROM grouping_folders"):
        if (
            folder["expanded"] not in (0, 1)
            or normalize_relative_path(folder["path"]) != folder["path"]
            or not db.execute(
                "SELECT 1 FROM grouping_nodes WHERE workspace=? AND id=?",
                (folder["workspace"], folder["node"]),
            ).fetchone()
        ):
            raise ReplicaError("Private grouping folder is inconsistent")
    for stem in db.execute("SELECT * FROM grouping_stems"):
        if not 0 <= stem["level"] <= stem["maximum"] or stem["maximum"] < 1:
            raise ReplicaError("Invalid private grouping stem level")
    for command in db.execute("SELECT * FROM grouping_commands"):
        if (
            command["state"] not in {"queued", "running", "succeeded", "failed", "paused"}
            or command["phase"]
            not in {"edit", "roles", "copy", "plan", "splice", "export", "verification", "done"}
            or command["revision"] < 1
            or command["sequence"] < 1
            or not isinstance(json.loads(command["intent"]), dict)
        ):
            raise ReplicaError("Invalid private grouping edit receipt")

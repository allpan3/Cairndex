"""Disk-backed complete grouping context; worker batches never define bundle boundaries"""

import json
import os
import sqlite3
from pathlib import PurePosixPath

from cairndex.domain.enums import FileRole, MediaKind
from cairndex.grouping import suggester as rules
from cairndex.replicas.catalog.model import value_text
from cairndex.replicas.catalog.projection import read_row
from cairndex.replicas.catalog.store import CatalogStore
from cairndex.replicas.discovery_sources import file_id, stable_id
from cairndex.scanning.media_types import classify

SCHEMA = """
CREATE TABLE IF NOT EXISTS discovery_plan_files (
    run TEXT NOT NULL, path TEXT NOT NULL, directory TEXT NOT NULL, body TEXT NOT NULL,
    file_id TEXT NOT NULL, kind TEXT NOT NULL, rank INTEGER NOT NULL, natural BLOB NOT NULL,
    stem TEXT NOT NULL, prefix TEXT NOT NULL, part TEXT, owner TEXT, owner_title TEXT,
    proposal TEXT, role TEXT, sequence INTEGER, PRIMARY KEY(run,path));
CREATE INDEX IF NOT EXISTS discovery_plan_directory ON
discovery_plan_files(run,directory,owner,kind,stem);
CREATE INDEX IF NOT EXISTS discovery_plan_group ON
discovery_plan_files(run,proposal,rank,natural,path);
CREATE TABLE IF NOT EXISTS discovery_plan_directories (
    run TEXT NOT NULL, path TEXT NOT NULL, phase TEXT NOT NULL DEFAULT 'videos',
    cursor TEXT NOT NULL DEFAULT '', PRIMARY KEY(run,path));
CREATE TABLE IF NOT EXISTS discovery_plan_groups (
    run TEXT NOT NULL, id TEXT NOT NULL, directory TEXT NOT NULL, parent TEXT,
    title TEXT NOT NULL DEFAULT '', target TEXT, kind TEXT NOT NULL DEFAULT 'bundle',
    folder INTEGER NOT NULL DEFAULT 0, stage TEXT NOT NULL DEFAULT 'match',
    cursor INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(run,id));
CREATE INDEX IF NOT EXISTS discovery_plan_group_directory ON
discovery_plan_groups(run,directory,kind,stage);
CREATE TABLE IF NOT EXISTS discovery_plan_folders (
    run TEXT NOT NULL, proposal TEXT NOT NULL, path TEXT NOT NULL,
    PRIMARY KEY(run,proposal,path));
"""
TABLES = {
    "discovery_plan_files",
    "discovery_plan_directory",
    "discovery_plan_group",
    "discovery_plan_directories",
    "discovery_plan_groups",
    "discovery_plan_group_directory",
    "discovery_plan_folders",
}
BATCH = 32


# SQLite sorts bounded keys using the same natural filename ordering as the shared suggester
def natural(path: str) -> bytes:
    output = bytearray()
    for part in rules._natural_key(path):
        if isinstance(part, int):
            digits = str(part).encode()
            output.extend(b"\x02" + len(digits).to_bytes(4, "big") + digits)
        else:
            output.extend(b"\x01" + str(part).encode() + b"\x00")
    return bytes(output)


# Stable private proposal keys identify semantics rather than the current worker batch
def group_id(directory: str, subject: str) -> str:
    return stable_id(["discovery-group", directory, subject])


# Index every fresh observation and settled owner before grouping any of their directory context
def index_batch(store: CatalogStore, run: str, after: str, *, known: bool) -> bool:
    with store.connection() as db:
        if known:
            rows = db.execute(
                "SELECT entity,path FROM catalog_paths WHERE family='asset_files' "
                "AND path>? ORDER BY path LIMIT ?",
                (after, BATCH),
            ).fetchall()
        else:
            rows = db.execute(
                "SELECT body,path FROM discovery_entries WHERE run=? AND handled=0 AND path>? "
                "ORDER BY path LIMIT ?",
                (run, after, BATCH),
            ).fetchall()
        for row in rows:
            path = row["path"]
            classified = classify(path)
            if not classified:
                continue
            kind = classified[0]
            owner, owner_title = None, None
            if known:
                file = read_row(db, "asset_files", row[0])
                bundle = read_row(db, "asset_bundles", file["bundle_id"]) if file else None
                if not file or not bundle:
                    continue
                identity, body = row[0], {}
                owner, owner_title = bundle["id"], bundle["title"]
            else:
                body = json.loads(row[0])
                prior = db.execute(
                    "SELECT file_id FROM discovery_identities WHERE path=? AND evidence=?",
                    (path, value_text(body["evidence"])),
                ).fetchone()
                identity = (
                    prior[0]
                    if prior
                    else file_id(store.descriptor.library_uuid, store.descriptor.epoch, body)
                )
                db.execute(
                    "INSERT OR IGNORE INTO discovery_identities VALUES (?,?,?)",
                    (path, value_text(body["evidence"]), identity),
                )
                body = body | {"id": identity}
            directory = path.rpartition("/")[0]
            db.execute(
                "INSERT OR REPLACE INTO discovery_plan_files "
                "(run,path,directory,body,file_id,kind,rank,natural,stem,prefix,part,"
                "owner,owner_title) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    run,
                    path,
                    directory,
                    value_text(body),
                    identity,
                    kind.value,
                    rules._MEDIA_SEQUENCE_RANK.get(kind, 3),
                    natural(path),
                    rules._normalized_stem(path, fold_rendition=True),
                    rules._subject_prefix(path),
                    rules._part_base(path) if kind is MediaKind.VIDEO else None,
                    owner,
                    owner_title,
                ),
            )
            if not known:
                while True:
                    db.execute(
                        "INSERT OR IGNORE INTO discovery_plan_directories(run,path) VALUES (?,?)",
                        (run, directory),
                    )
                    if not directory:
                        break
                    directory = directory.rpartition("/")[0]
        db.execute(
            "UPDATE discovery_runs SET cursor=? WHERE id=?", (rows[-1]["path"] if rows else "", run)
        )
        return not rows


# Whole-directory aggregates determine grouping once, independently of source enumeration pages
def directory_stats(db: sqlite3.Connection, run: str, directory: str) -> sqlite3.Row:
    result: sqlite3.Row = db.execute(
        "SELECT COUNT(*) AS files,COALESCE(SUM(kind='video'),0) AS videos,"
        "COUNT(DISTINCT CASE WHEN kind='video' THEN part END) AS parts,"
        "COALESCE(SUM(kind='video' AND part IS NULL),0) AS no_part "
        "FROM discovery_plan_files WHERE run=? AND directory=? AND owner IS NULL",
        (run, directory),
    ).fetchone()
    return result


# Videos establish every subject before any sidecar chooses its unique matching subject
def assign_batch(db: sqlite3.Connection, run: str, directory: sqlite3.Row) -> None:
    path, phase = directory["path"], directory["phase"]
    stats = directory_stats(db, run, path)
    one = (
        stats["videos"] == 1
        or stats["videos"] >= 2
        and stats["parts"] == 1
        and not stats["no_part"]
    )
    rows = db.execute(
        "SELECT * FROM discovery_plan_files WHERE run=? AND directory=? AND owner IS NULL "
        "AND path>? AND (kind='video')=? ORDER BY path LIMIT ?",
        (run, path, directory["cursor"], int(phase == "videos"), BATCH),
    ).fetchall()
    for file in rows:
        subject = (
            "one"
            if one
            else "video:" + file["stem"]
            if phase == "videos"
            else "file:" + file["path"]
        )
        identity = group_id(path, subject)
        if not one and phase != "videos" and stats["videos"]:
            exact = db.execute(
                "SELECT proposal FROM discovery_plan_files WHERE run=? AND directory=? "
                "AND owner IS NULL AND kind='video' AND stem=? LIMIT 1",
                (run, path, file["stem"]),
            ).fetchone()
            matches = []
            if not exact:
                for prefix in rules._space_prefixes(file["stem"]):
                    match = db.execute(
                        "SELECT proposal FROM discovery_plan_files WHERE run=? AND directory=? "
                        "AND owner IS NULL AND kind='video' AND stem=? LIMIT 1",
                        (run, path, prefix),
                    ).fetchone()
                    if match:
                        matches.append(match[0])
                if len(matches) != 1:
                    matches = [
                        row[0]
                        for row in db.execute(
                            "SELECT DISTINCT proposal FROM discovery_plan_files WHERE run=? "
                            "AND directory=? AND owner IS NULL AND kind='video' "
                            "AND prefix=? LIMIT 2",
                            (run, path, file["prefix"]),
                        )
                    ]
            if exact or len(matches) == 1:
                identity = exact[0] if exact else matches[0]
        db.execute(
            "INSERT OR IGNORE INTO discovery_plan_groups(run,id,directory,parent) VALUES (?,?,?,?)",
            (run, identity, path, path or None),
        )
        db.execute(
            "UPDATE discovery_plan_files SET proposal=? WHERE run=? AND path=?",
            (identity, run, file["path"]),
        )
    db.execute(
        "UPDATE discovery_plan_directories SET cursor=?,phase=? WHERE run=? AND path=?",
        (
            rows[-1]["path"] if rows else "",
            phase if rows else "sidecars" if phase == "videos" else "assigned",
            run,
            path,
        ),
    )


# Settled ownership matching reads every owner and subject, including those beyond earlier pages
def match_group(db: sqlite3.Connection, run: str, group: sqlite3.Row) -> None:
    path, identity = group["directory"], group["id"]
    owners = db.execute(
        "SELECT DISTINCT owner FROM discovery_plan_files WHERE run=? AND directory=? "
        "AND owner IS NOT NULL LIMIT 2",
        (run, path),
    ).fetchall()
    target = None
    if owners:
        scored = db.execute(
            "SELECT k.owner,MAX(CASE WHEN f.stem=k.stem THEN 3 "
            "WHEN substr(f.stem,1,length(k.stem)+1)=k.stem||' ' OR "
            "substr(k.stem,1,length(f.stem)+1)=f.stem||' ' THEN 2 ELSE 0 END) AS score "
            "FROM discovery_plan_files f JOIN discovery_plan_files k ON k.run=f.run "
            "AND k.directory=f.directory WHERE f.run=? AND f.proposal=? AND k.owner IS NOT NULL "
            "AND (f.kind='video' OR NOT EXISTS (SELECT 1 FROM discovery_plan_files v "
            "WHERE v.run=f.run AND v.proposal=f.proposal AND v.kind='video')) "
            "AND (k.kind='video' OR NOT EXISTS (SELECT 1 FROM discovery_plan_files v "
            "WHERE v.run=k.run AND v.directory=k.directory AND v.owner=k.owner "
            "AND v.kind='video')) "
            "GROUP BY k.owner HAVING score>0 ORDER BY score DESC,k.owner LIMIT 2",
            (run, identity),
        ).fetchall()
        if scored and (len(scored) == 1 or scored[0][1] > scored[1][1]):
            target = scored[0][0]
        elif not scored and len(owners) == 1:
            groups = db.execute(
                "SELECT COUNT(*) FROM discovery_plan_groups WHERE run=? AND directory=?",
                (run, path),
            ).fetchone()[0]
            if groups == 1 or not directory_stats(db, run, path)["videos"]:
                target = owners[0][0]
    db.execute(
        "UPDATE discovery_plan_groups SET target=?,stage='matched' WHERE run=? AND id=?",
        (target, run, identity),
    )


# Consolidating one target's additions changes no existing member or collection placement
def combine_additions(db: sqlite3.Connection, run: str, path: str) -> None:
    for (target,) in db.execute(
        "SELECT DISTINCT target FROM discovery_plan_groups WHERE run=? AND directory=? "
        "AND target IS NOT NULL",
        (run, path),
    ):
        identity = group_id(path, "addition:" + target)
        db.execute(
            "INSERT OR IGNORE INTO discovery_plan_groups(run,id,directory,target,stage) "
            "VALUES (?,?,?,?,'classified')",
            (run, identity, path, target),
        )
        db.execute(
            "UPDATE discovery_plan_files SET proposal=? WHERE run=? AND proposal IN "
            "(SELECT id FROM discovery_plan_groups WHERE run=? AND directory=? AND target=?)",
            (identity, run, run, path, target),
        )
        db.execute(
            "DELETE FROM discovery_plan_groups WHERE run=? AND directory=? AND target=? AND id<>?",
            (run, path, target, identity),
        )


# Folder classification uses complete direct groups and already classified child subtrees
def classify_directory(db: sqlite3.Connection, run: str, path: str) -> None:
    direct = db.execute(
        "SELECT COUNT(*) AS groups,COALESCE(SUM(n=1),0) AS singles FROM ("
        "SELECT g.id,COUNT(f.path) AS n FROM discovery_plan_groups g "
        "JOIN discovery_plan_files f ON f.run=g.run AND f.proposal=g.id "
        "WHERE g.run=? AND g.directory=? AND g.target IS NULL GROUP BY g.id)",
        (run, path),
    ).fetchone()
    children = db.execute(
        "SELECT COUNT(*) AS groups,COALESCE(SUM(kind='bundle' AND folder=1),0) AS albums "
        "FROM discovery_plan_groups WHERE run=? AND parent=? AND directory<>? AND target IS NULL",
        (run, path, path),
    ).fetchone()
    parent = path.rpartition("/")[0] or None
    merge_children = bool(
        path
        and direct["groups"] == 1
        and children["groups"]
        and children["groups"] == children["albums"]
    )
    album = (
        not children["groups"]
        and direct["groups"] >= rules.FOLDER_MEMBER_THRESHOLD
        and direct["singles"] >= direct["groups"] * 0.9
    )
    if path and (album or merge_children):
        identity = group_id(path, "folder")
        if merge_children:
            db.execute(
                "UPDATE discovery_plan_folders SET proposal=? WHERE run=? AND proposal IN "
                "(SELECT id FROM discovery_plan_groups WHERE run=? AND parent=? AND directory<>?)",
                (identity, run, run, path, path),
            )
        else:
            db.execute(
                "INSERT OR IGNORE INTO discovery_plan_folders VALUES (?,?,?)", (run, identity, path)
            )
        db.execute(
            "UPDATE discovery_plan_files SET proposal=? WHERE run=? AND proposal IN "
            "(SELECT id FROM discovery_plan_groups WHERE run=? AND target IS NULL "
            "AND (directory=? OR (? AND parent=?)))",
            (identity, run, run, path, merge_children, path),
        )
        db.execute(
            "DELETE FROM discovery_plan_groups WHERE run=? AND target IS NULL "
            "AND (directory=? OR (? AND parent=?))",
            (run, path, merge_children, path),
        )
        db.execute(
            "INSERT INTO discovery_plan_groups(run,id,directory,parent,title,folder,stage) "
            "VALUES (?,?,?,?,?,?,'classified')",
            (run, identity, path, parent, PurePosixPath(path).name, int(album)),
        )
    elif path and (children["groups"] or direct["groups"] > 1):
        db.execute(
            "INSERT INTO discovery_plan_groups(run,id,directory,parent,title,kind,stage) "
            "VALUES (?,?,?,?,?,'container','classified')",
            (run, group_id(path, "container"), path, parent, PurePosixPath(path).name),
        )
        db.execute(
            "UPDATE discovery_plan_groups SET parent=?,stage='classified' WHERE run=? "
            "AND directory=? AND kind='bundle' AND target IS NULL",
            (path, run, path),
        )
    else:
        db.execute(
            "UPDATE discovery_plan_groups SET parent=?,title=CASE WHEN ?<>'' THEN ? ELSE title END,"
            "stage='classified' WHERE run=? AND directory=? AND target IS NULL",
            (parent, path, PurePosixPath(path).name, run, path),
        )
    db.execute(
        "UPDATE discovery_plan_directories SET phase='complete' WHERE run=? AND path=?", (run, path)
    )


# Shared stem titles are reduced without retaining the directory's files in memory
def title(db: sqlite3.Connection, run: str, group: str, videos: int) -> str:
    shared, first, count, equal = None, "", 0, True
    for (path,) in db.execute(
        "SELECT path FROM discovery_plan_files WHERE run=? AND proposal=? "
        "AND (?<=1 OR kind='video') ORDER BY rank,natural,path",
        (run, group, videos),
    ):
        stem = rules._stem(path)
        count += 1
        if shared is None:
            shared, first = stem, stem
        else:
            equal = equal and first == stem
            shared = os.path.commonprefix((shared, stem))
    if shared and not equal:
        boundaries = list(rules._SUBJECT_DELIMITER.finditer(shared))
        if boundaries:
            shared = shared[: boundaries[-1].start()]
    return shared if count > 1 and shared else first


# Roles and order are assigned after consolidation; source batches never reset sequences or covers
def finish_group(db: sqlite3.Connection, run: str, group: sqlite3.Row) -> None:
    identity = group["id"]
    stats = db.execute(
        "SELECT COUNT(*) AS files,SUM(kind='video') AS videos,COUNT(DISTINCT part) AS parts,"
        "SUM(kind='video' AND part IS NULL) AS no_part FROM discovery_plan_files "
        "WHERE run=? AND proposal=?",
        (run, identity),
    ).fetchone()
    cover = db.execute(
        "SELECT file_id FROM discovery_plan_files WHERE run=? AND proposal=? AND kind='image' "
        "AND directory=? "
        "ORDER BY stem IN ('cover','poster','thumbnail','thumb','folder','front') DESC,"
        "natural,path LIMIT 1",
        (run, identity, group["directory"]),
    ).fetchone()
    rows = db.execute(
        "SELECT path,file_id,kind,directory FROM discovery_plan_files WHERE run=? AND proposal=? "
        "AND role IS NULL ORDER BY directory<>?,directory,rank,natural,path LIMIT ?",
        (run, identity, group["directory"], BATCH),
    ).fetchall()
    directory_roles: dict[str, tuple[int, bool, str | None]] = {}
    for sequence, file in enumerate(rows, start=group["cursor"]):
        directory = file["directory"]
        if directory not in directory_roles:
            local = db.execute(
                "SELECT COUNT(*) AS videos,COUNT(DISTINCT part) AS parts,"
                "SUM(part IS NULL) AS no_part FROM discovery_plan_files "
                "WHERE run=? AND proposal=? AND kind='video' AND directory=?",
                (run, identity, directory),
            ).fetchone()
            first = db.execute(
                "SELECT file_id FROM discovery_plan_files WHERE run=? AND proposal=? "
                "AND kind='video' AND directory=? ORDER BY natural,path LIMIT 1",
                (run, identity, directory),
            ).fetchone()
            directory_roles[directory] = (
                local["videos"],
                local["videos"] >= 2 and local["parts"] == 1 and not local["no_part"],
                first[0] if first else None,
            )
        videos, multipart, first_video = directory_roles[directory]
        observation = rules.FileObservation(file["file_id"], file["path"], MediaKind(file["kind"]))
        role = rules._role_for(observation, multipart, cover[0] if cover else None)
        if group["target"]:
            role = {
                MediaKind.VIDEO: FileRole.VIDEO_PART,
                MediaKind.IMAGE: FileRole.IMAGE,
                MediaKind.SUBTITLE: FileRole.SUBTITLE,
            }.get(observation.media_kind, FileRole.ATTACHMENT)
        elif (
            observation.media_kind is MediaKind.VIDEO
            and videos > 1
            and not multipart
            and file["file_id"] != first_video
        ):
            role = FileRole.ALTERNATE_VERSION
        db.execute(
            "UPDATE discovery_plan_files SET role=?,sequence=? WHERE run=? AND path=?",
            (role.name, sequence, run, file["path"]),
        )
    db.execute(
        "UPDATE discovery_plan_groups SET title=?,stage=?,cursor=cursor+? WHERE run=? AND id=?",
        (
            group["title"] or title(db, run, identity, stats["videos"]),
            "ready" if len(rows) < BATCH else "roles",
            len(rows),
            run,
            identity,
        ),
    )


# Each scheduling step handles one bounded assignment batch or one complete relational grouping
def tick(db: sqlite3.Connection, run: str) -> bool:
    directory = db.execute(
        "SELECT * FROM discovery_plan_directories WHERE run=? AND phase IN ('videos','sidecars') "
        "ORDER BY path LIMIT 1",
        (run,),
    ).fetchone()
    if directory:
        assign_batch(db, run, directory)
        return False
    group = db.execute(
        "SELECT * FROM discovery_plan_groups WHERE run=? AND stage='match' ORDER BY id LIMIT 1",
        (run,),
    ).fetchone()
    if group:
        match_group(db, run, group)
        return False
    directory = db.execute(
        "SELECT * FROM discovery_plan_directories WHERE run=? AND phase='assigned' "
        "ORDER BY length(path) DESC,path LIMIT 1",
        (run,),
    ).fetchone()
    if directory:
        combine_additions(db, run, directory["path"])
        classify_directory(db, run, directory["path"])
        return False
    group = db.execute(
        "SELECT * FROM discovery_plan_groups WHERE run=? "
        "AND stage IN ('classified','roles') AND kind='bundle' "
        "ORDER BY id LIMIT 1",
        (run,),
    ).fetchone()
    if group:
        finish_group(db, run, group)
        return False
    return True

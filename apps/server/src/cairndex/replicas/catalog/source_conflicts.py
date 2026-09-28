"""Retain references authored concurrently with a change of file content."""

import sqlite3


def ancestor(db: sqlite3.Connection, earlier: str, later: str) -> bool:
    if earlier == later:
        return True
    return (
        db.execute(
            "WITH RECURSIVE history(event) AS (VALUES (?) UNION "
            "SELECT p.parent FROM catalog_parents p JOIN history h ON p.child=h.event) "
            "SELECT 1 FROM history WHERE event=? LIMIT 1",
            (later, earlier),
        ).fetchone()
        is not None
    )


def concurrent_content(db: sqlite3.Connection, lifetime: str) -> bool:
    """Lifetime guards carry the actual editor ancestry even without a content edit.

    Equal live Boolean values must not hide a reference authored against a different
    content branch. This check uses event ancestry, never transport arrival order.
    """
    if not lifetime.startswith("asset_files/") or not lifetime.endswith("/$alive"):
        return False
    content = lifetime.removesuffix("$alive") + "$content"
    contents = db.execute(
        "SELECT event,value FROM catalog_revisions WHERE unit=? AND active=1", (content,)
    ).fetchall()
    guards = db.execute(
        "SELECT event FROM catalog_revisions WHERE unit=? AND active=1 AND value='true'",
        (lifetime,),
    ).fetchall()
    # Independent discovery of identical bytes is not a content replacement.
    # Only a revision that changes previously observed content can invalidate
    # a concurrent reference to that file identity.
    replacements = [
        version
        for version in contents
        if any(
            previous[1] != version[1] and ancestor(db, previous[0], version[0])
            for previous in db.execute(
                "SELECT event,value FROM catalog_revisions WHERE unit=? AND event!=?",
                (content, version[0]),
            )
        )
    ]
    return any(
        not ancestor(db, version[0], guard[0]) and not ancestor(db, guard[0], version[0])
        for version in replacements
        for guard in guards
    )


def affected(db: sqlite3.Connection, unit: str) -> set[str]:
    lifetimes = set()
    if unit.startswith("asset_files/"):
        lifetimes.add(unit.rsplit("/", 1)[0] + "/$alive")
    lifetimes.update(
        row[0]
        for row in db.execute(
            "SELECT DISTINCT g.target FROM catalog_guards g JOIN catalog_revisions r "
            "ON r.event=g.event AND r.unit=g.unit WHERE g.unit=? AND r.active=1",
            (unit,),
        )
    )
    result: set[str] = set()
    for lifetime in lifetimes:
        if not concurrent_content(db, lifetime):
            continue
        result.update((lifetime, lifetime.removesuffix("$alive") + "$content"))
        result.update(
            row[0]
            for row in db.execute(
                "SELECT DISTINCT g.unit FROM catalog_guards g JOIN catalog_revisions r "
                "ON r.event=g.event AND r.unit=g.unit WHERE g.target=? AND r.active=1",
                (lifetime,),
            )
        )
    return result

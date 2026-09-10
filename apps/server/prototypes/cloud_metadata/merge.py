"""Causal multi-value fields with conservative, indivisible relationship conflicts"""

from dataclasses import dataclass
from typing import Any

from .protocol import Event, Invalid, encode


# Keep the value and every equal-valued concurrent writer for honest resolution
@dataclass
class Choice:
    value: Any
    writers: list[str]


# Separate unresolved candidates from values safe to materialize
@dataclass
class View:
    values: dict[str, Any]
    conflicts: dict[str, list[Choice]]
    references: set[str]


# Compute transitive causality for the bounded experiment, independent of delivery order
def ancestors(events: dict[str, Event]) -> dict[str, set[str]]:
    result: dict[str, set[str]] = {}
    waiting = dict(events)
    while waiting:
        ready = [event for event in waiting.values() if all(p in result for p in event.parents)]
        if not ready:
            raise Invalid("missing or cyclic ancestry")
        for event in ready:
            result[event.id] = set(event.parents)
            for parent in event.parents:
                result[event.id].update(result[parent])
            del waiting[event.id]
    return result


# Frontier identifies exactly what an editor observed, including unresolved branches
def heads(events: dict[str, Event]) -> list[str]:
    return sorted(set(events) - {p for event in events.values() for p in event.parents})


# Recover a complete branch without changing the active view
# Ancestors stay private and retained even when transport files disappear
def branch(events: dict[str, Event], frontier: list[str]) -> dict[str, Event]:
    lineage = ancestors(events)
    selected = set(frontier)
    for item in frontier:
        if item not in lineage:
            raise Invalid("unknown editor basis")
        selected.update(lineage[item])
    return {key: events[key] for key in selected}


# Model references explicitly so missing metadata is never mistaken for missing media
def references(key: str, value: Any) -> list[str]:
    parts = key.split("/")
    if parts[0] == "member" and value:
        return parts[1:]
    if parts[0] == "order" and value is not None:
        return [parts[1], *value]
    if key == "tree/collections":
        return [node for children in value.values() for node in children]
    return []


# Retain concurrent values, merging only writers causally superseded on that field
def evaluate(events: dict[str, Event]) -> View:
    lineage = ancestors(events)
    writers: dict[str, list[str]] = {}
    for event in events.values():
        for key in event.changes:
            writers.setdefault(key, []).append(event.id)
    values: dict[str, Any] = {}
    conflicts: dict[str, list[Choice]] = {}
    for key, revisions in writers.items():
        tips = [r for r in revisions if not any(r in lineage[other] for other in revisions)]
        groups: dict[bytes, Choice] = {}
        for tip in sorted(tips):
            value = events[tip].changes[key]
            token = encode(value)
            groups.setdefault(token, Choice(value, [])).writers.append(tip)
        if len(groups) == 1:
            values[key] = next(iter(groups.values())).value
        else:
            conflicts[key] = list(groups.values())
    broken = {
        key
        for key, value in values.items()
        if any(
            values.get(f"entity/{entity}/alive") is not True for entity in references(key, value)
        )
    }
    owners: dict[str, set[str]] = {}
    for key in writers:
        if not key.startswith("order/"):
            continue
        candidates = [values[key]] if key in values else [c.value for c in conflicts[key]]
        for candidate in candidates:
            for member in candidate or []:
                owners.setdefault(member, set()).add(key)
    for units in owners.values():
        if len(units) > 1:
            broken.update(units)  # A conflict on one bundle must also fence dependent transfers
    paths: dict[str, list[str]] = {}
    for key, value in values.items():
        if key.endswith("/path") and values.get(key.rsplit("/", 1)[0] + "/alive") is True:
            paths.setdefault(value, []).append(key)
    for keys in paths.values():
        if len(keys) > 1:
            broken.update(keys)  # Ambiguous file identity never becomes a guessed merge
    return View(values, conflicts, broken)


# Leave conflicted controls at their last good saved value with an explicit badge
# Values are never selected by timestamp, device preference or lexical event order
def materialize(previous: dict[str, Any], view: View) -> dict[str, Any]:
    result = dict(previous)
    blocked_entities = {
        key.split("/")[1]
        for key in view.conflicts
        if key.startswith("entity/") and key.endswith("/alive")
    }
    for key, value in view.values.items():
        parts = key.split("/")
        if key in view.references or (parts[0] == "entity" and parts[1] in blocked_entities):
            continue
        result[key] = value
    return result


# Validate complete local intent against its observed branch before durable acceptance
def validate_transition(events: dict[str, Event], event: Event) -> None:
    base = branch(events, event.parents)
    before = evaluate(base)
    after = evaluate({**base, event.id: event})
    if after.references - before.references:
        raise Invalid("relationship requires live metadata")
    for key, value in event.changes.items():
        parts = key.split("/")
        if parts[0] != "entity":
            continue
        alive = f"entity/{parts[1]}/alive"
        if (
            alive not in before.values
            and alive not in before.conflicts
            and (
                event.changes.get(alive) is not True
                or f"entity/{parts[1]}/title" not in event.changes
            )
        ):
            raise Invalid("new entity requires complete identity")
        if parts[2] != "alive" and before.values.get(alive) is False:
            raise Invalid("restore lifetime explicitly before editing")
        if parts[2] == "alive" and value is True and before.values.get(alive) is False:
            raise Invalid("deleted identity requires explicit recovery as a new entity")

"""Ownership-lease file format, classification, and manager behavior (ADR-0018).

These tests drive the lease against real files in a temp directory — the point
of the design is that the *folder* is the medium, so faking the filesystem would
test the wrong thing. Time and sleeping are injected instead.
"""

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from cairndex.core.errors import LeaseTakeoverRequiredError, LibraryLeaseHeldError
from cairndex.ownership.lease import (
    LeaseRecord,
    LeaseSnapshot,
    LeaseState,
    classify,
    create_lease_exclusive,
    find_conflict_artifacts,
    new_nonce,
    parse_lease,
    read_lease,
    write_lease,
)
from cairndex.ownership.manager import LeaseManager, LeaseSettings
from cairndex.registry import library_package as pkg

OUR_UUID = "01SERVERAAAAAAAAAAAAAAAAAA"
THEIR_UUID = "01SERVERBBBBBBBBBBBBBBBBBB"
NOW = datetime(2026, 7, 20, 12, 0, 0, tzinfo=UTC)
TTL = timedelta(minutes=5)


def make_record(
    *,
    server_uuid: str = THEIR_UUID,
    machine_name: str = "NAS",
    advertised_url: str | None = "http://nas:8000",
    heartbeat_at: datetime = NOW,
    released_at: datetime | None = None,
    nonce: str | None = None,
) -> LeaseRecord:
    return LeaseRecord(
        server_uuid=server_uuid,
        machine_name=machine_name,
        advertised_url=advertised_url,
        acquired_at=heartbeat_at,
        heartbeat_at=heartbeat_at,
        nonce=nonce or new_nonce(),
        released_at=released_at,
    )


def classify_at(snapshot: LeaseSnapshot, *, now: datetime = NOW) -> LeaseState:
    return classify(snapshot, our_uuid=OUR_UUID, now=now, ttl=TTL)


# --- format ---------------------------------------------------------------


def test_record_round_trips_through_json() -> None:
    record = make_record()
    parsed = parse_lease(record.to_json())
    assert parsed == record


def test_released_lease_round_trips_its_release_timestamp() -> None:
    record = make_record(released_at=NOW)
    parsed = parse_lease(record.to_json())
    assert parsed is not None
    assert parsed.released_at == NOW


def test_a_live_lease_omits_released_at_entirely() -> None:
    # Rather than writing null: a reader checks presence, and an explicit null
    # would be indistinguishable from a key someone stripped.
    assert "released_at" not in json.loads(make_record().to_json())


@pytest.mark.parametrize(
    "raw",
    [
        "not json at all",
        "[]",
        '{"machine_name": "NAS"}',  # no server_uuid
        '{"server_uuid": "x", "nonce": "n", "acquired_at": "nope", "heartbeat_at": "nope"}',
        '{"server_uuid": "", "nonce": "n", "acquired_at": "2026-07-20T12:00:00+00:00",'
        ' "heartbeat_at": "2026-07-20T12:00:00+00:00"}',
    ],
)
def test_malformed_leases_do_not_parse(raw: str) -> None:
    assert parse_lease(raw) is None


def test_write_then_read_round_trips_on_disk(tmp_path: Path) -> None:
    record = make_record()
    write_lease(tmp_path, record)
    assert read_lease(tmp_path).record == record


def test_write_leaves_no_temp_files_behind(tmp_path: Path) -> None:
    write_lease(tmp_path, make_record())
    write_lease(tmp_path, make_record())
    assert [p.name for p in pkg.locks_dir(tmp_path).iterdir()] == [pkg.LEASE_NAME]


def test_exclusive_create_succeeds_once_then_refuses(tmp_path: Path) -> None:
    assert create_lease_exclusive(tmp_path, make_record(server_uuid=OUR_UUID)) is True
    assert create_lease_exclusive(tmp_path, make_record(server_uuid=THEIR_UUID)) is False
    # The loser must not have overwritten the winner.
    snapshot = read_lease(tmp_path)
    assert snapshot.record is not None
    assert snapshot.record.server_uuid == OUR_UUID


def test_reading_a_missing_lease_is_absent_not_corrupt(tmp_path: Path) -> None:
    snapshot = read_lease(tmp_path)
    assert snapshot.absent
    assert not snapshot.corrupt


def test_reading_garbage_is_corrupt_not_absent(tmp_path: Path) -> None:
    pkg.locks_dir(tmp_path).mkdir(parents=True)
    pkg.lease_path(tmp_path).write_text("{ truncated", encoding="utf-8")
    snapshot = read_lease(tmp_path)
    assert snapshot.corrupt
    assert not snapshot.absent


# --- classification -------------------------------------------------------


def test_no_lease_is_released(tmp_path: Path) -> None:
    assert classify_at(read_lease(tmp_path)) is LeaseState.RELEASED


def test_cleanly_released_lease_is_released() -> None:
    snapshot = LeaseSnapshot(record=make_record(released_at=NOW))
    assert classify_at(snapshot) is LeaseState.RELEASED


def test_our_own_lease_is_own_even_when_long_stale() -> None:
    """We crashed. A lease in our name cannot be another server's, so no prompt."""
    snapshot = LeaseSnapshot(record=make_record(server_uuid=OUR_UUID, heartbeat_at=NOW))
    assert classify_at(snapshot, now=NOW + timedelta(days=30)) is LeaseState.OWN


def test_recent_foreign_lease_is_fresh() -> None:
    snapshot = LeaseSnapshot(record=make_record(heartbeat_at=NOW - timedelta(seconds=30)))
    assert classify_at(snapshot) is LeaseState.FRESH


def test_foreign_lease_past_the_ttl_is_stale() -> None:
    snapshot = LeaseSnapshot(record=make_record(heartbeat_at=NOW - timedelta(minutes=6)))
    assert classify_at(snapshot) is LeaseState.STALE


def test_a_heartbeat_exactly_at_the_ttl_is_still_fresh() -> None:
    snapshot = LeaseSnapshot(record=make_record(heartbeat_at=NOW - TTL))
    assert classify_at(snapshot) is LeaseState.FRESH


def test_a_future_heartbeat_reads_as_fresh() -> None:
    """A peer whose clock runs ahead must never look abandoned.

    Skew errs toward refusing to serve, which is the recoverable direction.
    """
    snapshot = LeaseSnapshot(record=make_record(heartbeat_at=NOW + timedelta(hours=2)))
    assert classify_at(snapshot) is LeaseState.FRESH


def test_an_unreadable_lease_is_not_treated_as_free() -> None:
    """The central safety property: "cannot tell" must not become "nobody has it"."""
    assert classify_at(LeaseSnapshot(corrupt=True)) is LeaseState.UNREADABLE


# --- conflict artifacts ---------------------------------------------------


@pytest.mark.parametrize(
    "name",
    [
        "active-owner (conflicted copy 2026-07-20).json",
        "active-owner.sync-conflict-20260720-120000-ABCDEFG.json",
        "active-owner (1).json",
    ],
)
def test_sync_conflict_copies_are_detected(tmp_path: Path, name: str) -> None:
    locks = pkg.locks_dir(tmp_path)
    locks.mkdir(parents=True)
    (locks / name).write_text("{}", encoding="utf-8")
    assert find_conflict_artifacts(tmp_path) == [name]


def test_the_lease_itself_is_never_reported_as_a_conflict(tmp_path: Path) -> None:
    write_lease(tmp_path, make_record())
    assert find_conflict_artifacts(tmp_path) == []


# --- manager --------------------------------------------------------------


class FakeClock:
    def __init__(self, start: datetime = NOW) -> None:
        self.now = start

    def __call__(self) -> datetime:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += timedelta(seconds=seconds)


def build_manager(
    *,
    clock: FakeClock | None = None,
    sleep: object = None,
    on_ownership_lost: object = None,
) -> tuple[LeaseManager, FakeClock]:
    the_clock = clock or FakeClock()
    manager = LeaseManager(
        server_uuid=OUR_UUID,
        machine_name="laptop",
        advertised_url=None,
        settings=LeaseSettings(heartbeat_interval=60.0, ttl=300.0, verify_delay=0.0),
        clock=the_clock,
        sleep=sleep or (lambda _seconds: None),  # type: ignore[arg-type]
        on_ownership_lost=on_ownership_lost,  # type: ignore[arg-type]
    )
    return manager, the_clock


def test_acquiring_an_unowned_library_writes_our_lease(tmp_path: Path) -> None:
    manager, _ = build_manager()
    manager.ensure_owned(library_id="lib1", root=tmp_path)

    assert manager.holds("lib1", tmp_path)
    snapshot = read_lease(tmp_path)
    assert snapshot.record is not None
    assert snapshot.record.server_uuid == OUR_UUID
    assert snapshot.record.released_at is None


def test_the_mount_gate_does_no_io_once_the_lease_is_held(tmp_path: Path) -> None:
    """The hot path must not stat a possibly-offline NAS mount per request."""
    manager, _ = build_manager()
    manager.ensure_owned(library_id="lib1", root=tmp_path)

    pkg.lease_path(tmp_path).unlink()  # would fail any re-read
    manager.ensure_owned(library_id="lib1", root=tmp_path)  # must not raise


def test_a_library_re_registered_at_a_new_root_is_not_considered_held(tmp_path: Path) -> None:
    manager, _ = build_manager()
    first, second = tmp_path / "a", tmp_path / "b"
    first.mkdir()
    second.mkdir()
    manager.ensure_owned(library_id="lib1", root=first)

    assert not manager.holds("lib1", second)
    manager.ensure_owned(library_id="lib1", root=second)
    assert read_lease(second).record is not None


def test_a_live_foreign_lease_is_refused_with_the_holder(tmp_path: Path) -> None:
    write_lease(tmp_path, make_record(heartbeat_at=NOW))
    manager, _ = build_manager()

    with pytest.raises(LibraryLeaseHeldError) as excinfo:
        manager.ensure_owned(library_id="lib1", root=tmp_path)

    assert excinfo.value.details is not None
    assert excinfo.value.details["machine_name"] == "NAS"
    assert excinfo.value.details["advertised_url"] == "http://nas:8000"
    assert not manager.holds("lib1")


def test_a_stale_foreign_lease_demands_confirmation_rather_than_auto_takeover(
    tmp_path: Path,
) -> None:
    write_lease(tmp_path, make_record(heartbeat_at=NOW - timedelta(hours=9)))
    manager, _ = build_manager()

    with pytest.raises(LeaseTakeoverRequiredError) as excinfo:
        manager.ensure_owned(library_id="lib1", root=tmp_path)

    assert excinfo.value.details is not None
    assert excinfo.value.details["machine_name"] == "NAS"
    # The foreign lease is left exactly as it was.
    snapshot = read_lease(tmp_path)
    assert snapshot.record is not None
    assert snapshot.record.server_uuid == THEIR_UUID


def test_an_unreadable_lease_demands_confirmation_too(tmp_path: Path) -> None:
    pkg.locks_dir(tmp_path).mkdir(parents=True)
    pkg.lease_path(tmp_path).write_text("garbage", encoding="utf-8")
    manager, _ = build_manager()

    with pytest.raises(LeaseTakeoverRequiredError):
        manager.ensure_owned(library_id="lib1", root=tmp_path)


def test_a_confirmed_takeover_of_a_quiet_stale_lease_succeeds(tmp_path: Path) -> None:
    write_lease(tmp_path, make_record(heartbeat_at=NOW - timedelta(hours=9)))
    manager, _ = build_manager()

    manager.acquire(library_id="lib1", root=tmp_path, confirm_takeover=True)

    assert manager.holds("lib1", tmp_path)
    snapshot = read_lease(tmp_path)
    assert snapshot.record is not None
    assert snapshot.record.server_uuid == OUR_UUID


def test_a_holder_that_stirs_during_the_observation_window_keeps_the_library(
    tmp_path: Path,
) -> None:
    """The clock-free half of the guard.

    A holder sharing this disk (two servers on one NAS export) can look stale by
    timestamp yet be very much alive. It proves that by touching the file while
    we watch, and it wins — even though the user already said "take it".

    The holder deliberately stirs *only* during the long observation sleep and
    stays quiet through the short write-then-verify one. Without that split the
    test passes even with the observation window deleted, because write-verify
    would catch the same steal — and it would then be asserting nothing about
    the mechanism it names. (Confirmed by mutation: removing the observation
    call fails this test.)
    """
    write_lease(tmp_path, make_record(heartbeat_at=NOW - timedelta(hours=9)))
    observation = LeaseSettings(heartbeat_interval=60.0, ttl=300.0, verify_delay=0.0)
    slept: list[float] = []

    def sleep_but_the_holder_wakes(seconds: float) -> None:
        slept.append(seconds)
        if seconds == observation.observation_window:
            write_lease(tmp_path, make_record(heartbeat_at=NOW, machine_name="NAS"))

    manager, _ = build_manager(sleep=sleep_but_the_holder_wakes)

    with pytest.raises(LibraryLeaseHeldError) as excinfo:
        manager.acquire(library_id="lib1", root=tmp_path, confirm_takeover=True)

    assert excinfo.value.details is not None
    assert excinfo.value.details["machine_name"] == "NAS"
    assert not manager.holds("lib1")
    # And the foreign lease is untouched: we backed off without writing.
    holder = read_lease(tmp_path).record
    assert holder is not None
    assert holder.server_uuid == THEIR_UUID


def test_the_observation_window_outlasts_a_heartbeat_period(tmp_path: Path) -> None:
    """Shorter than one heartbeat and a live holder could sleep through it."""
    write_lease(tmp_path, make_record(heartbeat_at=NOW - timedelta(hours=9)))
    settings = LeaseSettings(heartbeat_interval=60.0, ttl=300.0, verify_delay=0.0)
    slept: list[float] = []

    manager, _ = build_manager(sleep=slept.append)
    manager.acquire(library_id="lib1", root=tmp_path, confirm_takeover=True)

    assert max(slept) > settings.heartbeat_interval


def test_we_reclaim_our_own_crashed_lease_without_asking(tmp_path: Path) -> None:
    write_lease(tmp_path, make_record(server_uuid=OUR_UUID, heartbeat_at=NOW - timedelta(days=3)))
    manager, _ = build_manager()

    manager.ensure_owned(library_id="lib1", root=tmp_path)

    assert manager.holds("lib1", tmp_path)


def test_a_lease_stolen_between_our_write_and_our_verify_is_not_claimed(tmp_path: Path) -> None:
    """Write-then-verify, the substitute for a compare-and-swap we cannot have.

    Nothing atomic exists on a synced folder or an SMB share, so the claim is
    only real if it survives a read-back.
    """
    stolen = make_record(server_uuid=THEIR_UUID, machine_name="NAS")

    def steal_during_verify(_seconds: float) -> None:
        write_lease(tmp_path, stolen)

    manager, _ = build_manager(sleep=steal_during_verify)
    # A released lease exists, so acquisition takes the write-then-verify path
    # rather than the uncontended exclusive-create one.
    write_lease(tmp_path, make_record(server_uuid=THEIR_UUID, released_at=NOW))

    with pytest.raises(LibraryLeaseHeldError) as excinfo:
        manager.ensure_owned(library_id="lib1", root=tmp_path)

    assert excinfo.value.details is not None
    assert excinfo.value.details["machine_name"] == "NAS"
    assert not manager.holds("lib1")


# --- heartbeat / watchdog -------------------------------------------------


def test_a_heartbeat_refreshes_the_nonce_and_keeps_the_original_acquisition_time(
    tmp_path: Path,
) -> None:
    manager, clock = build_manager()
    manager.ensure_owned(library_id="lib1", root=tmp_path)
    first = read_lease(tmp_path).record
    assert first is not None

    clock.advance(60)
    assert manager.heartbeat_once() == []

    second = read_lease(tmp_path).record
    assert second is not None
    assert second.nonce != first.nonce
    assert second.heartbeat_at > first.heartbeat_at
    assert second.acquired_at == first.acquired_at


def test_a_foreign_takeover_is_detected_and_the_library_is_unmounted(tmp_path: Path) -> None:
    unmounted: list[str] = []
    manager, _ = build_manager(on_ownership_lost=unmounted.append)
    manager.ensure_owned(library_id="lib1", root=tmp_path)

    write_lease(tmp_path, make_record(server_uuid=THEIR_UUID, machine_name="NAS"))

    assert manager.heartbeat_once() == ["lib1"]
    assert unmounted == ["lib1"]
    assert not manager.holds("lib1")


def test_we_never_grab_the_lease_back_after_losing_it(tmp_path: Path) -> None:
    """Two servers each re-grabbing would be the alternating dual-writer itself."""
    manager, _ = build_manager()
    manager.ensure_owned(library_id="lib1", root=tmp_path)
    theirs = make_record(server_uuid=THEIR_UUID)
    write_lease(tmp_path, theirs)

    manager.heartbeat_once()

    assert read_lease(tmp_path).record == theirs


def test_our_uuid_under_a_nonce_we_did_not_write_counts_as_lost(tmp_path: Path) -> None:
    """A sync engine resolving a conflict can hand back a record bearing our own
    uuid that is not the one we wrote. The nonce is what makes that visible."""
    manager, _ = build_manager()
    manager.ensure_owned(library_id="lib1", root=tmp_path)
    write_lease(tmp_path, make_record(server_uuid=OUR_UUID, nonce="a-nonce-we-never-wrote"))

    assert manager.heartbeat_once() == ["lib1"]


def test_a_lease_that_became_unreadable_is_surrendered(tmp_path: Path) -> None:
    manager, _ = build_manager()
    manager.ensure_owned(library_id="lib1", root=tmp_path)
    pkg.lease_path(tmp_path).write_text("garbage", encoding="utf-8")

    assert manager.heartbeat_once() == ["lib1"]


def test_a_vanished_lease_is_rewritten_rather_than_surrendered(tmp_path: Path) -> None:
    """Nobody claimed it — we are still the incumbent, so we restate it."""
    manager, _ = build_manager()
    manager.ensure_owned(library_id="lib1", root=tmp_path)
    pkg.lease_path(tmp_path).unlink()

    assert manager.heartbeat_once() == []
    assert manager.holds("lib1")
    snapshot = read_lease(tmp_path)
    assert snapshot.record is not None
    assert snapshot.record.server_uuid == OUR_UUID


# --- release --------------------------------------------------------------


def test_release_makes_the_next_server_acquire_silently(tmp_path: Path) -> None:
    """The everyday flow: quit laptop 1, open laptop 2, no prompt."""
    manager, _ = build_manager()
    manager.ensure_owned(library_id="lib1", root=tmp_path)
    manager.release("lib1")

    assert not manager.holds("lib1")
    assert classify_at(read_lease(tmp_path), now=NOW) is LeaseState.RELEASED

    other = LeaseManager(
        server_uuid=THEIR_UUID,
        machine_name="other laptop",
        advertised_url=None,
        settings=LeaseSettings(heartbeat_interval=60.0, ttl=300.0, verify_delay=0.0),
        clock=FakeClock(),
        sleep=lambda _s: None,
    )
    other.ensure_owned(library_id="lib1", root=tmp_path)
    assert other.holds("lib1")


def test_release_does_not_overwrite_a_lease_that_already_moved_on(tmp_path: Path) -> None:
    manager, _ = build_manager()
    manager.ensure_owned(library_id="lib1", root=tmp_path)
    theirs = make_record(server_uuid=THEIR_UUID)
    write_lease(tmp_path, theirs)

    manager.release("lib1")

    assert read_lease(tmp_path).record == theirs


def test_releasing_something_we_never_held_is_a_no_op(tmp_path: Path) -> None:
    manager, _ = build_manager()
    manager.release("lib1")
    assert read_lease(tmp_path).absent

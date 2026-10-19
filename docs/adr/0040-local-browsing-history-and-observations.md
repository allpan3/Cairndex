# ADR-0040: Local browsing history and observations

- Status: accepted within the owner's restoration scope
- Date: 2026-10-19
- Amends: ADR-0035's deferral of local history

## Context

The portable workspace omitted Date Opened, Date Modified and Size sorting.
Those were deferred features, rather than replacements. The owner requested
their restoration from the current device's history and observations, without
importing saved positions from conversion backups. Cross-device playback
synchronization remains separate.

## Decision

Keep opening history and observed file sizes private to the serving instance.
Opening a bundle album or viewer records Date Opened. Mere card
selection, inspection, pagination and background metadata reads do not open it.
Recent continues to list all bundles with its date-sort choices; Date Opened
provides recently used order. Never-opened bundles have an unknown opening time.

Date Modified retains its earlier meaning: a bundle metadata change, not a
source file's filesystem modification time. Record when this instance observes
a changed projected bundle or one of its owned metadata rows. Unchanged guards,
opening and media progress do not count. Existing authored `updated_at` supplies
the baseline before this instance observes an edit. Remote edit arrival time is
a local observation; it does not establish a shared chronological order.

Size sums the current bundle's file sizes only when every member has a matching
local path observation. Otherwise it is unknown. Update and selected-file
inspection collect these facts within their existing bounded work. Browse and
sort queries never stat or probe source files. Unknown sizes and opening times
sort last in either direction, with stable identity ties.

## Alternatives

- Synchronize browsing activity through authored history: deferred with
  cross-device resume. Ordinary viewing must not create catalog conflicts.
- Stat every bundle while sorting: rejected because paging would cause
  unbounded source access, especially on network storage.
- Call filesystem changes Date Modified: rejected because that changes the
  established metadata-sort meaning.

## Consequences

Private SQLite gains additive observation/history tables; the portable format
does not change. Recovery retains history but discards file facts that must be
observed again on the destination. A new server initially has unknown sizes and
opening times. Conversion backups remain untouched.

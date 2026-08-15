# Next session: drag-and-drop in the Bundle Browser does not survive its own cache

Read `AGENTS.md` first. This file is a handoff, not a spec — it records what was
observed, what was ruled out, and where three attempts went wrong. Delete it when the
work lands.

## The two symptoms, as the owner reported them

1. **Dragging a bundle into a collection often does not show.** The bundle stays in
   the collection it left, or never appears in the one it joined. Reloading the app
   always shows the correct state. The sidebar count sometimes moves when the listing
   does not. Intermittent.
2. **⌥-drag should copy and mostly moves.** With the last attempt applied it copied
   *sometimes*. Holding ⌥ is meant to add the bundle to the target collection without
   removing it from the one being viewed.

The owner's own summary is the best framing available: *"This seems to be a lasting
issue. Even if the files are on SMB, I had no issue with Eagle."* They are right that
this is not about the network. Every symptom is client-side cache behaviour.

## What is already established, with evidence

**The server is correct.** A service-level reproduction — create two collections, put a
confirmed bundle in A, call `bundle_service.batch_update_bundles(add=[B], remove=[A])`
— gives source count 0 and empty listing, destination count 1 holding the bundle. Do
not re-derive this; write it as a test if you want it pinned, but the defect is not
here.

**`update_bundles` honours ⌥ correctly.** With `remove_collection_ids` empty the
membership change is a pure add. The whole client path passes the flag through:
`Sidebar.tsx` (tree rows) and `CollectionHeader.tsx` (collection cards) both hand
`e.altKey` to `moveBundlesToCollection` in `App.tsx`, which omits the removal when it
is set. Reading the code will not find a missing hop; there isn't one.

**Keyboard events do not reach the page during a native macOS drag.** The window
server owns the keyboard for the duration, so listening for `keydown` can only ever
see ⌥ *held before* the mouse goes down. This is why attempt 2 failed.

**The browser computes the answer for us, and we overwrite it.** Per the HTML
drag-and-drop model the user agent sets `dataTransfer.dropEffect` from `effectAllowed`
and the platform's modifier state *before* dispatching each `dragover`. All three
dragover handlers immediately assign to `dropEffect` to drive the cursor badge, so the
only evidence that ⌥ is down is destroyed before anything reads it. Attempt 3 read it
first and was *intermittently* right — the untested suspicion is that our own write
leaks into the next event's initial value, making the read partly self-fulfilling. **A
measurement of what the webview actually reports is the missing input.** Add a
temporary on-screen readout of `altKey`, `getModifierState('Alt')`, the incoming
`dropEffect` and `effectAllowed` on dragover and drop, have the owner ⌥-drag once, and
work from facts. Three guesses have been spent; do not make a fourth.

## Why the cache half is a design problem, not a missing guard

`useBatchUpdate` in `apps/web/src/api/hooks.ts` optimistically rewrites the browse
listings on every drop (`projectCollectionListings`, `cachedSummaries`,
`listingHoldsBundle`) and then reconciles with `invalidateQueries`. There are many
cached listings — one per collection, view, sort, and include-descendants flag — and
the rewrite is best-effort in a way that fails silently:

- `projectCollectionListings` only adds an arriving bundle if `cachedSummaries` can
  find its summary in some already-cached page. When it cannot, the destination
  listing keeps its pre-drop contents and nothing says so.
- `invalidateQueries({queryKey: ['browse']})` defaults to `refetchType: 'active'`, so
  every listing the owner is *not* looking at is marked stale but keeps its data —
  and React Query serves a stale query's cached data immediately, refetching behind
  it. Opening that collection shows the old list first.
- Attempt 1 added `'browse'` to the `cancelQueries` list in `onMutate`, which was
  genuinely missing: an in-flight fetch resolves *after* the optimistic write, clobbers
  it, and the `onSettled` invalidation is then deduplicated against that same request.
  It helped and did not fix it.

Two directions worth weighing before writing code:

- **Make the server authoritative for listings.** Drop the listing surgery, keep the
  count optimism (small, self-correcting, and it is what makes the drag feel instant),
  and on settle refetch active browse queries while *evicting* inactive ones
  (`removeQueries({queryKey: ['browse'], type: 'inactive'})`) so no stale answer can be
  served. The optimism was added when the library database was on SMB and every query
  was slow; after ADR-0022 a metadata write plus refetch is tens of milliseconds, so it
  buys much less than it did. An attempt at exactly this broke four existing tests and
  was abandoned unfinished — those four tests are the specification of the current
  behaviour and should be read before deciding, not worked around.
- **Keep the optimism and make it total.** Derive arrivals from the payload rather than
  from whatever happens to be cached, so it cannot silently no-op. More code, and it
  has to stay correct as sorts and filters grow.

## Reverted work to mine, not to trust

Four commits were made and then removed from this branch's history rather than left
as revert noise in a grouping PR. Both of the following are described completely enough
here to re-implement; nothing depends on recovering a diff:

- **The counts fix.** `collection_counts` and `tag_counts` counted membership rows without
  joining `asset_bundles`, so a collection reported bundles its listing hides (a
  scan-staged provisional bundle belongs to the Unbundled view and nowhere else). The
  fix and its two tests were verified: the first failed against the old query with
  count 2 against a listing of 1. **Worth cherry-picking as its own change** — it is a
  real inconsistency and unrelated to the drag. The change is small: join
  `AssetBundle` on the membership table's `bundle_id` and add
  `.where(not_(_unbundled_predicate()))`, in both functions in
  `apps/server/src/cairndex/services/browse.py`.
- **The missing cancel.** Add `'browse'` to the `cancelQueries` list in
  `useBatchUpdate`'s `onMutate` (`apps/web/src/api/hooks.ts`), with a test that
  reproduces the clobber (seed a listing, start a fetch that resolves after the
  mutation, assert the bundle is gone). Necessary, and on its own not sufficient.

## Reproducing without a hand on the keyboard

The cache half needs no ⌥ and no native drag: call the same mutation the drop calls,
with a browse fetch in flight and the destination listing cached-but-inactive. That is
how both existing tests in `hooks.counts.test.tsx` work. The ⌥ half cannot be
reproduced programmatically — synthetic `DragEvent`s do not prime the drag store, and
the modifier state is exactly what is in question. Instrument and ask.

## Definition of done

The owner's test is the app, not the suite: drag a bundle between collections
repeatedly, with and without ⌥, without reloading, and have every listing and count
agree every time.

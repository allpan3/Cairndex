/**
 * Sidebar count arithmetic, applied to the cache before the server answers.
 *
 * The server counts a collection's whole *subtree* (`browse_service.collection_counts`),
 * so a bundle filed into a subcollection is counted once by every ancestor above
 * it — and a flat ±1 on the drop target would be wrong for exactly the most
 * common gesture, filing into a child of the collection being viewed. The client
 * already holds the collection tree, so the true delta is computable: express a
 * bundle's contribution as the *set* of collections that count it (each
 * membership plus every ancestor of that membership), and diff the set before
 * against the set after. Collections in only the after-set gain the bundle;
 * collections in only the before-set lose it; a move between a parent and its own
 * descendant leaves the shared ancestors in both sets, so they do not move — no
 * special case needed.
 *
 * Tag counts are direct membership (`browse_service.tag_counts`), so they are a
 * plain ±1 and share only the batching helpers here.
 *
 * These functions are pure so the arithmetic can be tested on a fixture tree
 * without a query client; `hooks.ts` owns reading and writing the caches.
 */

import type { CollectionRead } from './client'

/** One bundle's membership either side of a mutation. */
export interface MembershipChange {
  before: readonly string[]
  after: readonly string[]
}

/** Parent lookup for the ancestor walks below. */
function parentsOf(collections: readonly CollectionRead[]): Map<string, string | null> {
  return new Map(collections.map((c) => [c.id, c.parent_id ?? null]))
}

/**
 * Every collection that counts a bundle with these memberships: each membership
 * itself plus all of its ancestors. Unknown ids (a collection the client has not
 * loaded) still count themselves — the membership is real even when the row is
 * missing — they just contribute no ancestors.
 */
export function countingCollectionIds(
  collections: readonly CollectionRead[],
  memberships: Iterable<string>,
): Set<string> {
  const parents = parentsOf(collections)
  const covered = new Set<string>()
  for (const membership of memberships) {
    let current: string | null = membership
    // A parent chain should be acyclic, but a cycle here would hang the UI on a
    // drag; stop as soon as the walk revisits something it already counted.
    while (current !== null && !covered.has(current)) {
      covered.add(current)
      current = parents.get(current) ?? null
    }
  }
  return covered
}

/**
 * Whether a collection-scoped bundle listing would contain a bundle holding
 * these memberships.
 *
 * The same subtree rule the counts use, asked of one listing: a collection
 * showing only its own bundles holds the bundle when it is a direct
 * membership, while one showing its subcollections' contents too holds it
 * whenever the collection is among those *counting* it — the membership or any
 * ancestor of one. That equivalence is why this reuses `countingCollectionIds`
 * rather than re-deriving the walk.
 */
export function listingHoldsBundle(
  collections: readonly CollectionRead[],
  scopeCollectionId: string,
  includeDescendants: boolean,
  memberships: readonly string[],
): boolean {
  if (!includeDescendants) return memberships.includes(scopeCollectionId)
  return countingCollectionIds(collections, memberships).has(scopeCollectionId)
}

/**
 * Per-collection change in the sidebar count for a batch of bundles. Deltas are
 * computed per bundle (a bundle is counted once per collection however many of
 * its descendants hold it) and summed, so a multi-select move adds up correctly.
 */
export function collectionCountDeltas(
  collections: readonly CollectionRead[],
  changes: Iterable<MembershipChange>,
): Map<string, number> {
  const deltas = new Map<string, number>()
  const bump = (id: string, by: number) => deltas.set(id, (deltas.get(id) ?? 0) + by)
  for (const { before, after } of changes) {
    const was = countingCollectionIds(collections, before)
    const now = countingCollectionIds(collections, after)
    for (const id of now) if (!was.has(id)) bump(id, 1)
    for (const id of was) if (!now.has(id)) bump(id, -1)
  }
  return deltas
}

/**
 * Change in *direct* membership per id — a plain ±1 per bundle that did not
 * already hold it (or no longer does). This is what tag counts are made of, and
 * also a collection's own "bundles in this collection" figure, as opposed to the
 * subtree count above.
 */
export function directMembershipDeltas(changes: Iterable<MembershipChange>): Map<string, number> {
  const deltas = new Map<string, number>()
  const bump = (id: string, by: number) => deltas.set(id, (deltas.get(id) ?? 0) + by)
  for (const { before, after } of changes) {
    const was = new Set(before)
    const now = new Set(after)
    for (const id of now) if (!was.has(id)) bump(id, 1)
    for (const id of was) if (!now.has(id)) bump(id, -1)
  }
  return deltas
}

/**
 * How many bundles enter or leave an "in nothing" system view (Uncategorized for
 * collections, Untagged for tags): a bundle counts there only while its
 * membership is empty.
 */
export function emptyMembershipDelta(changes: Iterable<MembershipChange>): number {
  let delta = 0
  for (const { before, after } of changes) {
    if (before.length === 0 && after.length > 0) delta -= 1
    else if (before.length > 0 && after.length === 0) delta += 1
  }
  return delta
}

/** Apply deltas to a counts map. Counts never go below zero: the arithmetic is a
 * prediction, and a negative number on screen would be worse than a stale one. */
export function applyCountDeltas(
  counts: Record<string, number>,
  deltas: ReadonlyMap<string, number>,
): Record<string, number> {
  if (deltas.size === 0) return counts
  const next = { ...counts }
  for (const [id, delta] of deltas) {
    if (delta === 0) continue
    next[id] = Math.max(0, (next[id] ?? 0) + delta)
  }
  return next
}

/** The membership a bundle ends up with after an add/remove batch. Removals are
 * applied first so an id in both lists ends up present, matching the server. */
export function nextMembership(
  current: readonly string[],
  add: readonly string[] = [],
  remove: readonly string[] = [],
): string[] {
  const removed = new Set(remove)
  const next = current.filter((id) => !removed.has(id))
  for (const id of add) if (!next.includes(id)) next.push(id)
  return next
}

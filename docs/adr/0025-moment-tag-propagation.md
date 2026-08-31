# ADR-0025: A moment's tag propagates to its bundle, one way

- Status: accepted
- Date: 2026-08-29
- Branch/PR: `feat/moments` (plan 7)

## Context

[Plan 7](../plans/07-moments-and-range-loop.md) adds **moments**: instants
and spans the owner marks inside a video, each carrying an optional comment and
any number of tags. The owner's requirement was explicit:

> The tags are the same as the bundle tags, and any moment's tag will become
> bundle's tag as well.

"The same as the bundle tags" is unambiguous and cheap — a moment's tags are rows
in `tags`, the same hierarchy and the same groups, through the same picker. The
second half is not. A tag that "becomes the bundle's tag" could mean the bundle's
tag set is *computed* to include its moments' tags, or that assigning to a moment
*writes* to the bundle. The two differ in what happens next: what a later removal
does, and what the rest of the library has to learn.

Constraints from `AGENTS.md` that bear on it: filter expressions compile against
an allowlist of fields, list endpoints must paginate and sort deterministically,
searches and counts must be server-side and indexed rather than computed over a
loaded window, and the design must hold up on a multi-terabyte library.

## Decision

**Assigning a tag to a moment adds that tag to the moment's bundle as a real
`asset_bundle_tags` row. Removing the tag from the moment does not remove it from
the bundle, and neither does deleting the moment.**

The write is a union, not a replace: it adds what is being assigned and leaves
everything already on the bundle alone. It bumps `asset_bundles.updated_at` but
not `asset_bundles.version`.

## Alternatives considered

- **Derived union — bundle tags read as own-tags ∪ moment-tags.** Rejected. Every
  consumer of bundle tags would have to learn about a second source: the tags
  endpoint, `tag_counts`, the browse tag facet, the filter AST's tag field and its
  SQL compilation, Smart Collection previews, and the grouping suggester. That is
  a wide, permanently wider surface, in exchange for avoiding a one-line write at
  the single point of assignment. It also makes "remove this tag from the bundle"
  unanswerable while a moment still carries it — the pill would reappear, or the
  action would have to silently reach into moments the owner was not editing.

- **Two-way propagation — un-assigning from the moment un-assigns from the
  bundle.** Rejected as unsound, not merely inconvenient. A propagated assignment
  and a hand-made one are the *same row* in `asset_bundle_tags`; nothing
  distinguishes them. So un-propagating would sometimes remove a tag the owner
  had set on the bundle directly. Recording provenance to tell them apart means a
  new column, a rule for what happens when both sources claim a tag, and a
  migration — real cost for a behaviour nobody asked for.

- **No propagation; moment tags are moment-only.** Rejected: it is the one thing
  the owner asked for by name. A moment tag that never reaches the bundle cannot
  be browsed to, which makes marking-and-tagging a write-only gesture.

## Consequences

Easier:

- Nothing outside the moment service knows moments exist. Tag counts,
  filters, facets, and Smart Collections keep working because what they find is
  an ordinary bundle tag.
- The behaviour matches **Paste Tags**, which already adds without replacing, so
  the additive semantic is not new to the app.
- The way out already exists: *Remove from This Bundle* on the tag pill.

Harder, and accepted:

- A bundle accumulates tags. Tidying a moment away leaves its tag behind, and the
  owner has to remove it deliberately if they no longer want it. That is defended
  as the honest reading — a bundle that contained something at 1:23 still
  contained it after the marker is gone — but it is a real asymmetry and the
  reason this is an ADR rather than a code comment.
- A file moved to another bundle takes its moments with it (the denormalized
  `bundle_id` is maintained by the existing re-parent hook) while the tags it
  already propagated stay on the old bundle. Consistent with the rule above, and
  the same tidying applies.

Deliberately not decided here: whether to add a `has_moments` / `moment_count`
filter field. Propagation means the tag filters already reach these bundles, so
that is a later want rather than a gap this decision leaves.

## References

- [Plan 7 §4.1](../plans/07-moments-and-range-loop.md) — the design this records
- [`docs/data-model.md`](../data-model.md) — `moments`, `moment_tags`
- [ADR-0002](0002-core-schema-identity-and-hierarchy.md) — tag hierarchy and the
  join-table shape this mirrors

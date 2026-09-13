# Manual replica discovery review

Manual Update makes newly added local files reviewable in capable synthetic
replicas and repairs verified external moves without changing source media.
New groupings, additions and identity choices use guarded causal transactions;
private scans and drafts never become shared provisional bundles or tombstones.

## Scope and design

- Format 3, catalog 2, minimum reader 3 and `discovery_identity_v1` gate the workflow
- Stable small-file identities use complete evidence; large-file identities stay
  private until reviewed, with sampling limits visible
- Confirmed membership/metadata survives repair; prior local observation is required
  for automatic repair, and ambiguous source decisions require acceptance
- Worker batches, source revalidation and atomic authored/private receipts cover
  restart, cancellation, reviewed replacement and delivery-order conflicts
- Recovery retains candidates, large-file mappings, draft bytes and opening bases

No real-library conversion or migration is enabled. Existing formats retain their
capabilities. Collection/container grouping, full independent large-file equality
verification, provider qualification and directory pagination remain outside scope.
Source modification times initialize new timestamps and can conflict if peers
observe different mtimes; they are never causal authority.

## Validation

Backend Ruff, formatting and mypy pass. The full source suite reports 1,613 passed
and one existing FFmpeg zscale skip. Independent source and frozen sidecars pass
Update, acceptance, convergence, move and prepared-review recovery checks. Frozen
packaged smoke passes. Generated OpenAPI and TypeScript reproduce exactly.

Frontend lint, formatting, typecheck, all 1,214 unit tests and production build
pass. The existing chunk-size warning remains. Six final replica browser scenarios
pass, including three discovery scenarios covering independent discovery/convergence,
preserved editor selection and drafts, restored reviews, cancellation,
retry, malformed draft retention, library switching, moved-file playback and
competing replacement identities visible on both devices. Catalog, media and private
recovery regressions pass alongside discovery.
Focused hook tests cover dense input revisions, obsolete delivery errors and
retention of invalid nested draft bytes.

The isolated production desktop build and signature check pass. Native interactions
with verified foreground identity and focused controls visibly demonstrate Update,
typed private grouping, exact acceptance and decoded image playback after an external
synthetic move. Accepting another discovery that sorts ahead of the selected bundle
preserves that editor and its visible unsaved title. Private database readback confirms
both acceptance receipts, complete retained drafts and the stable moved-file ID/path.
All eight synthetic source hashes match, accounting for the intentional rename.
Normal Quit stops both app and sidecar; disposable fixtures, the app and isolated
runtime are removed. Catalog draft delivery fences obsolete responses and keeps
current failures separate from malformed-storage errors. Focused editor tests cover
rapid input, obsolete errors, current failures and retained malformed bytes.
Rust source is unchanged and its standalone gate was not repeated.

## Documentation updated

README, product brief, architecture, data model, development, replica catalog,
migration/recovery guides, ADR references/index, ADR-0032, the manual Update guide,
STATUS and CHANGELOG describe current behavior and boundaries.

## Privacy and delivery

Only source/reference text and reproducible API contracts belong in the change.
Synthetic fixtures are generated at runtime; no media, database, cache, binary or
build output belongs in the commit. The staged privacy gate passes for all 47
source/reference text files and reproducible API contracts.
The cumulative branch retains its existing 8 MiB publication-volume block. No push,
PR, deployment, release, history rewrite or privacy-gate bypass is authorized.

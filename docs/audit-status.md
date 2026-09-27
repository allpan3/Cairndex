# Audit status

Current disposition on `fix/library-ownership-lifecycle`, reconciled 2026-09-16
against implementation checkpoint `51e05546`, accepted ADRs and the owner's
subsequent decisions. This ledger covers the original I01–I29 register. Earlier
observations and test counts in [STATUS](STATUS.md#historical-validation-receipts)
are historical receipts, not claims about the current build or authorization for
more work. **Complete** means the approved bounded scope was implemented and
verified; it does not mean every deployment or scale is qualified.

## Current disposition

| Item | Status | Delivered scope and remaining boundary |
| --- | --- | --- |
| I01 — Maintenance ownership | Complete | Query benchmarking/reindexing acquire maintenance ownership before opening SQLite; these commands may write journal/plan state and are not mutation-free inspection |
| I02 — Release/unregister | Complete | Drain admitted work, checkpoint/close before lease release, persist deliberate Release/Reopen and fence lost ownership; cooperative leases cannot revoke OS work already issued |
| I03 — Read-only storage contract | Complete | Protected sources work with writable metadata; wholly read-only packages return an actionable refusal. Synthetic UID/container checks passed in the ownership group |
| I04 — Shared-server stale edits | Complete safety scope; editing follow-up open | Mandatory read bases and retry IDs, atomic receipts, disjoint edits, retained conflicts and connected refresh under ADR-0030; older clients must upgrade to save; current clients show early older-server guidance, retain blocked drafts and recover only through compatible reads and explicit draft review. Installed native checks pass; continuing a note list after the same client's prior save can require an unnecessary conflict review |
| I05 — Offline local replicas | Incomplete | Accepted ADR-0029 and synthetic complete catalogs, media, recovery and Update are implemented. Existing complete packages use shared bundle browsing, full-catalog search and scalar inspector controls; structured filters, ordinary File Browser and remaining inspector parity are incomplete. Real conversion, ordinary new replica-library creation and provider qualification are unavailable; see the capability boundary below |
| I06 — Saved filter preservation | Complete | Name-only saves retain exact nested expressions; unsupported simple-editor conditions are protected |
| I07 — Preview/browse populations | Complete | Preview and ordinary browse share the confirmed/visible population, including eligible empty and missing bundles |
| I08 — Filter contract/examples | Complete | Scoped routes, version/root envelope, compiler allowlist and simple-editor subset are documented and checked; richer filter UI remains deferred |
| I09 — Unbundled search/order | Complete | Filename search and global order run before SQL pagination; unchanged-catalog paging is deterministic, while concurrent edits can shift offsets |
| I10 — Bundle search scope | Complete | Bundle names, ordered bundle notes, file notes and moment comments are indexed; filename/path/tag/collection names and retired scalar notes are excluded |
| I11 — Directory/list scaling | Owner-deferred | Directory responses remain whole-directory and folded-name ties remain an open contract issue. Other whole-list endpoints still need a cardinality/limits census; Unbundled paging does not close this item |
| I12 — File metadata contract | Complete | Notes and verbatim origins round-trip; unsupported custom names are rejected without deleting stored legacy titles. File note/source editing UI remains deferred |
| I13 — Server/library navigation | Complete | Persistent chooser, local Browse, remembered destinations, isolated credentials/caches and packaged synthetic switching/restart checks; isolated NAS production-app reconnect and bidirectional browser/native edits also pass. Ownership notices offer saved or typed alternative addresses; desktop checks the same portable library before switching. Server-advertised addresses still depend on the client network |
| I14 — Playback intent | Complete | Buffering, pause intent, same-file replacement and source-scoped commands are separated; synthetic native premature EOF reproduction is fixed |
| I15 — Web playback qualification | Complete bounded scope | Synthetic direct/remux/transcode, seeks and hands-off progression pass. NAS synthetic paths and read-only representative decode/seek checks pass; heavier HEVC falls short of uninterrupted real time, and broad quality/device budgets remain unqualified |
| I16 — Native playback qualification | Complete bounded scope | Isolated production app shows decoded pictures, seeking, subtitles, ordered EOF and restart/resume; synthetic NAS direct/remux/transcode paths also have native evidence. Installed app replacement, exact restart resume, default SRT cues, paused seeks, synthetic 4K HEVC direct play and 1080p remux/transcode have bounded evidence. The historical owner-media transition and the newly reported unavailable source remain unattributed; background presentation and broader workloads are not qualified |
| I17 — Keyboard selection | Complete bounded scope | Focused range/additive selection, loaded-item Select All and virtualized Home/End pass in browser and native checks; comprehensive assistive-technology coverage remains open |
| I18 — Dialog cancellation | Complete | Collection creation is a local draft until Create; nested Escape, focus return and cancellation pass |
| I19 — Loading/empty/error states | Complete | Pending counts differ from zero, cached content survives failed refresh, and stale responses cannot replace the current selection |
| I20 — Outage recovery | Complete bounded scope | Remembered destination, retry/reconnect, auth/ownership guidance and synthetic packaged cold-outage recovery; actual isolated NAS process termination/restart also passes; mount loss and power loss remain unqualified |
| I21 — Density/discoverability | Complete bounded scope | Compact inspectors, panel fitting, readable narrow list names, View options and keyboard reference pass synthetic browser and production-desktop checks. Native Help, focused help scrolling, Tab/Escape, pointer-opener focus return, layout/size controls and preserved selection have visible evidence through background app-targeted control. Global accelerator routing and comprehensive assistive-technology qualification remain separate |
| I22 — Folder members | Complete bounded scope | Folder disclosure/selection continuity and parent/child playlist boundaries pass. Nested-member support and large-folder qualification remain separate |
| I23 — Desktop file integration | **INCOMPLETE and paused** | Mapped Open/Reveal, single-file Finder transfers, picker batches, copy/collision/identity/Undo regressions have evidence. QSpace, multi-file OS delivery and app-origin self-return remain open |
| I24 — Update/grouping recovery | Complete bounded scope | Incomplete walks, root replacement, stable-ID repair, trash preservation, stale plans and committed-result retries have synthetic process/browser coverage. Unconfirmed plans still discard on restart under ADR-0022; arbitrary ambiguous repair and power-loss qualification remain open |
| I25 — Performance/concurrent use | Incomplete qualification | Local query matrices, bounded thumbnail work and visible two-client playback/edit/Update checks pass. Bounded NAS browser/native playback, two-client edits and Mac SMB file checks pass; full startup, heavier HEVC, multi-terabyte scale and slowest aggregate/descendant queries remain follow-up |
| I26 — Documentation reconciliation | Complete for this group | Current references and this ledger separate implemented behavior, accepted decisions, historical receipts and explicit limitations; ADR-0019 is accepted, while genuinely proposed ADRs remain proposed |
| I27 — Safety/publication invariants | Preserved; continuing gate | Metadata-only defaults, journaled opt-in writes, scoped paths and stable IDs remain mandatory. Local committed-content review is separate from publication permission; cumulative volume gates still block publication |
| I28 — Storage accounting | Complete current accounting | Read-only inventory and a stable private DB copy reconcile the current gap as missing indexed bytes minus unindexed files, with no available-file size mismatch. DB, backup, cache and Trash are separate; exact historical per-file causes remain unavailable. No cleanup, purge or rescan is implied |
| I29 — Capability/security/deployment | Incomplete qualification | Scoped auth, pairing/relay, packaged synthetic lifecycles and private recovery have bounded evidence. Isolated hardened NAS image, permissions and shutdown smoke pass; broader release/provider/platform acceptance and unresolved ADR decisions remain open |

## Capability and decision boundaries

- The app keeps one selected server and one intended library; local sidecars and
  remote authoritative servers share the UI. NAS and cloud folders are storage
  scenarios, not required operating modes. Legacy libraries retain exclusive
  serving ownership and writable private metadata requirements.
- Cloud replicas are **synthetic-only qualification**. Accepted ADR-0029 uses
  private SQLite and immutable causal artifacts; independent fields combine,
  conflicts require complete reviewed choices, and rejected branches remain
  recoverable. Catalog metadata, local media, private backup/recovery and
  format-three manual Update have implementation and synthetic receipts.
  `CONVERSION_AVAILABLE = False`; neither existing-library conversion nor a
  normal user-facing new replica-library workflow is available. Real provider
  delivery/hydration, source writes, resume transport and compaction remain open.
- File-manager imports are copies, including same-library sources. File Browser
  collisions offer Replace/Skip/Keep Both; bundle targets choose a destination
  and suffix copies. Explicit Replace affects the destination and retains journal
  recovery. **ADR-0033, its macOS adapter/framework patch, volume-based Move and
  source deletion remain on hold.** Copy-only imports do not require their approval;
  self-return discrimination remains a separate unresolved requirement.
- Folder pagination/list redesign is owner-deferred. Slow measurements alone do
  not authorize it. Large-library readiness requires representative media and
  storage evidence beyond the current metadata-only 100k query matrix and small
  playable browser fixtures.
- ADR-0019 is owner-ratified. ADR-0014, ADR-0015 and ADR-0017 retain their proposed
  approval markers despite implemented HLS/pairing/relay mechanisms; this audit
  does not ratify them. ADR-0024 is superseded by implemented plan 6.
- Optional passphrase sessions and scoped device tokens are single-owner access
  guards. Public exposure hardening, token rotation/expiry/vault design,
  Developer ID/updater, broader platforms and Android beyond pairing remain
  separate decisions or qualification work. No telemetry or full RBAC is implied.
- Rich nested-filter editing, advanced/embedded subtitles, video-wall/adjustment/
  slideshow features, export-save into source libraries and duplicate resolution
  remain deferred. Eagle import is removed. Startup discard of unconfirmed legacy
  grouping plans, additive moment tags and explicitly armed looping remain
  accepted behavior.

## Replace identity disposition

**Mounted-SMB Copy/Replace/Undo is implemented for the tested topology.**
Accepted [ADR-0034](adr/0034-mounted-smb-copy-publication.md) supplies the narrow
signed/encrypted direct transport. Review repairs distinguish unavailable identity
from absence, isolate accounts, bind shares without redirects, prove directory
mapping with fresh bytes and delete only identity-verified probe/publication
handles. Repeated Undo uses server identity despite stale mounted entries.
[Current repair evidence](nas-verification.md#mounted-smb-review-repair-verification)
is separate from the earlier source and packaged receipts. Local and historical
receipt semantics remain unchanged. Broader servers, mount loss and power loss
remain unqualified. NAS-hosted serving and paused desktop OS drag remain separate.

Copy-import Replace follows ADR-0013 §5: a linked destination keeps its ID and
authored metadata, while the prior bytes receive a bytes-only Trash receipt.
Undo restores those bytes on the same identity, retains subsequent authored edits,
and invalidates derived media. Same-path imports follow this explicit Replace
contract; ordinary distinct copies and Keep Both remain independent. See
[Replace and Undo](file-operations.md) for cancellation, recovery and coverage.

Rename/Move Replace follows the owner-ratified source-identity rule in ADR-0013
§4–5: the source retains all metadata at its new path, while the displaced
identity and metadata remain in recoverable Trash. Undo restores both paths and
retains later edits; no metadata is merged. Versioned receipts cover interrupted
new replacements and their inverse without changing historical journal semantics.
Synthetic process/backend/browser coverage is recorded in [STATUS](STATUS.md).
Desktop integration remains **INCOMPLETE and paused**; this rule applies only to
existing explicit Rename/Move commands, not incoming file-manager drags.

## Evidence and original-register crosswalk

Current topic references: [connections](connections.md),
[shared edits](shared-server-edits.md), [filters](filter-language.md),
[interactions](interactions.md), [playback](proposals/playback-reliability-review.md),
[replica catalog](replica-catalog.md), [migration](replica-migration.md),
[private recovery](replica-recovery.md), [replica Update](replica-discovery.md),
[desktop receipts](desktop-file-integration-verification.md),
[performance](performance.md), and [NAS/storage verification](nas-verification.md).
Their test receipts belong to their stated commits;
this documentation group does not rerun or certify every runtime suite.

Original reproductions map as follows: R1→I07, R2→I09, R3→I06, R4→I01/I03,
R5→I02, R6→I12, R7→I11, R8→I08. R7 remains deferred; the others have bounded
fix/contract dispositions above. Original consistency findings C1–C12 map to
I26 plus their substantive owners: C1→I23/I27, C2→I06–I08/I10,
C3→I29, C4→I05/I24, C5→I10/I12, C6→I24, C7→I29,
C8→I22/I24, C9→I23, C10→I09/I11/I24/I25, C11→I29,
C12→I01–I03/I27. The original GUI and NAS observations retain their historical
boundaries; synthetic fixes do not retrospectively establish their causes.

## Remaining work

The main unfinished product work is qualifying and enabling ordinary cloud
replica use, completing the paused OS drag integration, and testing representative
native/NAS/provider workloads. Smaller follow-ups include the deferred listing
contracts, measured slow queries, usability/accessibility refinement, unresolved
ADR approvals and historical storage evidence if it becomes available. Deployment
and publication require their own owner authorization and fresh gates. Engineering owns the checks; this ledger
is not an owner testing checklist or authorization to resume those groups.

import {
  type DragEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'

import type {
  CollectionRead,
  GroupingApplyResult,
  GroupingPlan,
  GroupingProposal,
  GroupingStemMode,
  GroupingStemModes,
} from '../api/client'
import {
  useApplyGroupingPlan,
  useCollections,
  useGenerateGroupingPlan,
  useGroupingPlan,
  useGroupingPlans,
  useMoveGroupingProposalFile,
  useRenameGroupingProposal,
  useReparentGroupingProposal,
  useSetGroupingProposalDestination,
  useSetGroupingProposalKind,
  useSetGroupingStemMode,
} from '../api/hooks'
import { formatFileRole } from '../lib/format'
import { GroupingPlacementPicker, type GroupingPlacementOption } from './GroupingPlacementPicker'
import {
  IconChevron,
  IconChevronsIn,
  IconChevronsOut,
  IconFolder,
  IconGroup,
  IconLayers,
  IconRefreshCw,
  IconUngroup,
} from './icons'

/**
 * Review grouping suggestions and apply them (ADR-0009 phase 4).
 *
 * The scanner over-fragments a real library (one bundle per file). This surface
 * shows the suggester's plan — proposed bundles and the logical containers that
 * would hold them, with each file's role and a reason — and lets
 * the owner apply it. Applying confirms the bundles, creates the collections,
 * and links subtitles; nothing on disk is touched. Conflicts (files that moved,
 * vanished, or were already grouped by hand) are reported, not silently forced.
 */
/** The coarse media kind behind a suggester-assigned role.
 *
 * The review rows deliberately do **not** show the in-bundle role itself. The
 * suggester assigns roles by guessing intent from filenames — the first image
 * becomes `cover`, a second video `alternate_version` — and those guesses are
 * neither reliable nor (yet) editable, so labelling a row "alt version" invites
 * a guess to be read as a fact. `lib/format.ts` made that call for the
 * inspector; this keeps the review dialog speaking the same vocabulary
 * (video / image / subtitle), and falls back to the extension for roles that
 * carry no kind, exactly as `formatFileRole` does.
 */
const ROLE_MEDIA_KIND: Record<string, string> = {
  primary_video: 'video',
  video_part: 'video',
  alternate_version: 'video',
  cover: 'image',
  image: 'image',
  screenshot: 'image',
  album_image: 'image',
  subtitle: 'subtitle',
}

function baseName(path: string): string {
  return path.split('/').pop() ?? path
}

interface TreeNode {
  proposal: GroupingProposal
  children: TreeNode[]
}

/**
 * A compact icon button whose tooltip escapes the dialog's scrolling body.
 *
 * The body is `overflow: auto`, which clips an absolutely positioned `::after`
 * tooltip against the panel edge — reported for exactly these controls, whose
 * tooltips are the longest in the dialog (owner-reported, 2026-07-30). This
 * renders the tooltip into `document.body` at `position: fixed`, placed from the
 * button's own rect, so no ancestor can cut it off.
 *
 * The hover handlers sit on a wrapper rather than the button because a *disabled*
 * button fires no mouse events, and Narrow/Widen are disabled at the ends of
 * their scale — precisely when someone wants to know why. `data-tip` stays on the
 * button: it keeps the markup self-describing and is what the review tests read.
 */
function TipButton({
  tip,
  children,
  className,
  onClick,
  ...buttonProps
}: {
  tip: string
  children: ReactNode
  className: string
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'className'>) {
  const ref = useRef<HTMLButtonElement>(null)
  // The tip text is stored with the position, so a placement computed for a label
  // that has since changed is simply not rendered — see below.
  const [shown, setShown] = useState<{ tip: string; style: React.CSSProperties } | null>(null)

  const show = () => {
    const rect = ref.current?.getBoundingClientRect()
    if (!rect) return
    // Right-aligned via the CSS `right` property, so the width never has to be
    // measured; the clamp keeps a long tooltip on a right-hand control inside the
    // viewport. Above by default, below when a control near the top has no room.
    const right = Math.max(8, window.innerWidth - rect.right)
    const style =
      rect.top > 72
        ? { right, bottom: window.innerHeight - rect.top + 6 }
        : { right, top: rect.bottom + 6 }
    setShown({ tip, style })
  }
  const hide = () => setShown(null)

  // Only show a placement that was computed for the label being shown now. The
  // label flips once the action lands ("…a collection" → "…one bundle") and the
  // rows move in the same commit, while nothing makes the pointer leave the
  // button — so no `mouseleave` fires and the tooltip would otherwise hang around
  // at its old coordinates with the new text (owner-reported, 2026-07-30).
  // Derived rather than cleared in an effect, which would cascade a render.
  const placement = shown?.tip === tip ? shown.style : null

  // A fixed tooltip does not follow its button, and this list scrolls under the
  // pointer often enough that a stale one would be noticed.
  useEffect(() => {
    if (!placement) return
    window.addEventListener('scroll', hide, true)
    window.addEventListener('resize', hide)
    return () => {
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('resize', hide)
    }
  }, [placement])

  return (
    <span className="grp-tip-anchor" onMouseEnter={show} onMouseLeave={hide}>
      <button
        ref={ref}
        type="button"
        className={className}
        data-tip={tip}
        onFocus={show}
        onBlur={hide}
        // Dismiss on activation: the click is what moves the row out from under
        // the pointer, and a tooltip anchored to where it used to be is noise.
        onClick={(event) => {
          hide()
          onClick?.(event)
        }}
        {...buttonProps}
      >
        {children}
      </button>
      {placement &&
        createPortal(
          <span className="grp-tip" style={placement} role="tooltip">
            {tip}
          </span>,
          document.body,
        )}
    </span>
  )
}

/** The character index under a point, for placing the caret where it was clicked.
 *
 * `caretPositionFromPoint` is the standard spelling and `caretRangeFromPoint` the
 * WebKit one, which matters because the desktop shell is a WKWebView. Returns
 * `null` when neither exists, and the caller then falls back to the end of the
 * text — anything rather than selecting the whole title, which threw away the
 * name the moment you typed (owner-reported, 2026-07-30).
 */
function caretOffsetFromPoint(clientX: number, clientY: number): number | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offset: number } | null
    caretRangeFromPoint?: (x: number, y: number) => Range | null
  }
  const position = doc.caretPositionFromPoint?.(clientX, clientY)
  if (position) return position.offset
  const range = doc.caretRangeFromPoint?.(clientX, clientY)
  return range ? range.startOffset : null
}

/** Coordinate one persisted inline rename across the recursive proposal tree. */
interface RenameControls {
  canEdit: boolean
  editingId: string | null
  pending: boolean
  /** ``caretOffset`` places the caret where the title was double-clicked. */
  start: (proposal: GroupingProposal, caretOffset?: number | null) => void
  caretOffset: number | null
  commit: (proposalId: string, title: string) => void
  cancel: () => void
}

/** Coordinate one persisted existing-versus-new bundle choice. */
interface DestinationControls {
  canEdit: boolean
  pending: boolean
  set: (proposal: GroupingProposal, createNewBundle: boolean) => void
}

/** Coordinate per-directory stem sensitivity regeneration. */
interface StemControls {
  canEdit: boolean
  pending: boolean
  modes: GroupingStemModes
  set: (directory: string, mode: GroupingStemMode) => void
}

/** Coordinate the bundle-versus-collection override on one suggestion. */
interface KindControls {
  canEdit: boolean
  pending: boolean
  set: (proposal: GroupingProposal) => void
}

type ReviewDragItem =
  | { kind: 'file'; proposalId: string; assetFileId: string }
  | { kind: 'proposal'; proposalId: string; proposalKind: 'bundle' | 'container' }

type ReviewDropSlot =
  | { kind: 'file'; proposalId: string; assetFileId: string; before: boolean }
  | { kind: 'file-list'; proposalId: string }
  | { kind: 'collection'; proposalId: string }
  | { kind: 'root' }

/** Coordinate native drag-and-drop edits across the recursive proposal tree. */
interface DragControls {
  canEdit: boolean
  pending: boolean
  item: ReviewDragItem | null
  slot: ReviewDropSlot | null
  startFile: (event: DragEvent, proposalId: string, assetFileId: string) => void
  startProposal: (event: DragEvent, proposal: GroupingProposal) => void
  hover: (slot: ReviewDropSlot) => void
  dropFile: (targetProposalId: string, targetIndex: number) => void
  canDropProposal: (parentProposalId: string | null) => boolean
  dropProposal: (parentProposalId: string | null) => void
  end: () => void
}

/** Coordinate explicit keyboard-accessible placement of reviewed proposals */
interface PlacementControls {
  canEdit: boolean
  pending: boolean
  loading: boolean
  error: boolean
  options: GroupingPlacementOption[]
  proposals: Map<string, GroupingProposal>
  setCollection: (proposal: GroupingProposal, targetCollectionId: string | null) => void
}

/** Coordinate view-only folding across the recursive proposal tree */
interface FoldControls {
  collapsed: ReadonlySet<string>
  set: (key: string, collapsed: boolean) => void
}

function buildTree(proposals: GroupingProposal[]): TreeNode[] {
  const byParent = new Map<string | null, GroupingProposal[]>()
  for (const p of proposals) {
    const key = p.parent_proposal_id ?? null
    const list = byParent.get(key) ?? []
    list.push(p)
    byParent.set(key, list)
  }
  const make = (parent: string | null): TreeNode[] =>
    (byParent.get(parent) ?? []).map((proposal) => ({
      proposal,
      children: make(proposal.id),
    }))
  return make(null)
}

/**
 * A key for one suggestion that survives a change of proposal id.
 *
 * Narrow/Widen replaces the adjusted directory's rows in place (new ids for
 * those rows only), and a bundle↔collection conversion rebuilds a row's
 * subtree — so tracking which suggestions the owner unchecked by *id* is
 * fragile. These keys are derived from content instead: a bundle is its set of
 * files, a collection is its directory. A row whose content survives an edit
 * keeps its checkbox; rows that genuinely are new suggestions come back
 * checked.
 */
function proposalKey(proposal: GroupingProposal): string {
  if (proposal.kind === 'container') return `c:${proposal.directory}`
  const files = proposal.files
    .map((f) => f.asset_file_id)
    .sort()
    .join(',')
  // An addition targets one existing bundle, so that is part of its identity —
  // two additions to different bundles can otherwise hold the same file set.
  return `b:${proposal.target_bundle_id ?? ''}:${files}`
}

function collectKeys(nodes: TreeNode[]): Map<string, string> {
  const keys = new Map<string, string>()
  const visit = (items: TreeNode[]) => {
    for (const node of items) {
      keys.set(node.proposal.id, proposalKey(node.proposal))
      visit(node.children)
    }
  }
  visit(nodes)
  return keys
}

/** Collect every proposal with content that can be folded */
function collectFoldKeys(nodes: TreeNode[]): string[] {
  const keys = new Set<string>()
  const visit = (items: TreeNode[]) => {
    for (const node of items) {
      if (node.proposal.kind === 'bundle' || node.children.length > 0) {
        keys.add(proposalKey(node.proposal))
      }
      visit(node.children)
    }
  }
  visit(nodes)
  return [...keys]
}

/** Collect only file-backed bundle rows; collection rows are structural paths */
function collectBundleIds(nodes: TreeNode[]): string[] {
  return nodes.flatMap((node) => [
    ...(node.proposal.kind === 'bundle' && node.proposal.files.length > 0
      ? [node.proposal.id]
      : []),
    ...collectBundleIds(node.children),
  ])
}

/** Aggregate actionable bundle selection below one review node */
interface NodeSelection {
  total: number
  selected: number
}

/** Compute checked/empty/mixed state from each node's actionable bundles */
function selectionByNode(nodes: TreeNode[], selectedIds: Set<string>): Map<string, NodeSelection> {
  const result = new Map<string, NodeSelection>()
  const visit = (node: TreeNode): NodeSelection => {
    const own =
      node.proposal.kind === 'bundle' && node.proposal.files.length > 0
        ? { total: 1, selected: selectedIds.has(node.proposal.id) ? 1 : 0 }
        : { total: 0, selected: 0 }
    const state = node.children.reduce((sum, child) => {
      const childState = visit(child)
      return {
        total: sum.total + childState.total,
        selected: sum.selected + childState.selected,
      }
    }, own)
    result.set(node.proposal.id, state)
    return state
  }
  for (const node of nodes) visit(node)
  return result
}

/** Build picker destinations from the library's current persisted collections */
function collectionPlacementOptions(collections: CollectionRead[]): GroupingPlacementOption[] {
  const byId = new Map(collections.map((collection) => [collection.id, collection]))
  return collections.map((collection) => {
    const names: string[] = []
    const seen = new Set<string>()
    let current: CollectionRead | undefined = collection
    while (current && !seen.has(current.id)) {
      seen.add(current.id)
      names.push(current.name)
      current = current.parent_id ? byId.get(current.parent_id) : undefined
    }
    return {
      id: collection.id,
      parent_id: collection.parent_id,
      name: collection.name,
      path: names.reverse().join(' / '),
    }
  })
}

/** Describe a proposal's ancestry for the placement anchor only */
function proposalPlacementPath(
  proposal: GroupingProposal,
  proposals: Map<string, GroupingProposal>,
): string {
  const names: string[] = []
  const seen = new Set<string>()
  let current: GroupingProposal | undefined = proposal
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    names.push(proposalDisplayTitle(current))
    current = current.parent_proposal_id ? proposals.get(current.parent_proposal_id) : undefined
  }
  return names.reverse().join(' / ')
}

/** The folder one file lives in, from its library-relative path. */
function fileDirectory(relativePath: string): string {
  const slash = relativePath.lastIndexOf('/')
  return slash === -1 ? '' : relativePath.slice(0, slash)
}

/** Every folder whose files are represented below one review node.
 *
 * Derived from the files' own paths, deliberately not from `proposal.directory`.
 * Those agree for a suggested row, but not after the owner restructures: merging
 * a collection into one bundle leaves a row whose `directory` is the parent
 * folder while its files come from subfolders. Keying off `directory` there put
 * a stem control on a folder with no direct media of its own — a control that
 * could not narrow or widen anything, and whose one job (re-suggest this folder)
 * would delete the merged row and propose nothing in its place.
 */
function bundleDirectories(node: TreeNode, cache: Map<string, Set<string>>): Set<string> {
  const cached = cache.get(node.proposal.id)
  if (cached) return cached
  const directories = new Set<string>()
  for (const file of node.proposal.files) directories.add(fileDirectory(file.relative_path))
  for (const child of node.children) {
    for (const directory of bundleDirectories(child, cache)) directories.add(directory)
  }
  cache.set(node.proposal.id, directories)
  return directories
}

/** Place exactly one stem control beside each represented filesystem directory. */
function stemControlOwners(nodes: TreeNode[]): Map<string, string> {
  const containers: TreeNode[] = []
  const bundles: TreeNode[] = []
  const visit = (items: TreeNode[]) => {
    for (const node of items) {
      if (node.proposal.kind === 'container') containers.push(node)
      else bundles.push(node)
      visit(node.children)
    }
  }
  visit(nodes)

  const claimed = new Set<string>()
  const owners = new Map<string, string>()
  const directoryCache = new Map<string, Set<string>>()
  for (const node of [...containers].reverse()) {
    const directories = [...bundleDirectories(node, directoryCache)]
    if (directories.length !== 1) continue
    const directory = directories[0]!
    const representsDirectory =
      node.proposal.directory === directory ||
      node.proposal.title?.trim().toLowerCase() === baseName(directory).toLowerCase()
    if (!representsDirectory || claimed.has(directory)) continue
    owners.set(node.proposal.id, directory)
    claimed.add(directory)
  }
  for (const node of bundles) {
    // A bundle speaks for a folder only when all of its files live in that one
    // folder; a hand-merged row spanning several gets no control (see above).
    const directories = [...bundleDirectories(node, directoryCache)]
    if (directories.length !== 1) continue
    const directory = directories[0]!
    if (claimed.has(directory)) continue
    owners.set(node.proposal.id, directory)
    claimed.add(directory)
  }
  return owners
}

/** Collect bundle suggestions that became empty after a review drag */
function collectEmptyBundleIds(nodes: TreeNode[]): string[] {
  return nodes.flatMap((node) => [
    ...(node.proposal.kind === 'bundle' && node.proposal.files.length === 0
      ? [node.proposal.id]
      : []),
    ...collectEmptyBundleIds(node.children),
  ])
}

/** Resolve the stable destination label, including legacy open-plan fallback. */
function targetTitle(proposal: GroupingProposal): string {
  return proposal.target_bundle_title || proposal.title || 'bundle'
}

/** Build the title shown for the proposal's current destination mode. */
function proposalDisplayTitle(proposal: GroupingProposal): string {
  return proposal.target_bundle_id && !proposal.create_new_bundle
    ? `Add to ${targetTitle(proposal)}`
    : proposal.title || '(untitled)'
}

/** Describe the destination change performed by the compact switch button */
function destinationActionLabel(proposal: GroupingProposal): string {
  return proposal.create_new_bundle
    ? `Add these files to “${targetTitle(proposal)}” instead`
    : 'Create a new bundle from these files'
}

/** Render a compact accessible destination switch beside an addition title */
function DestinationToggle({
  proposal,
  hasItems,
  destination,
}: {
  proposal: GroupingProposal
  hasItems: boolean
  destination: DestinationControls
}) {
  const label = destinationActionLabel(proposal)
  return (
    <TipButton
      className="grp-destination"
      tip={label}
      aria-label={label}
      aria-pressed={proposal.create_new_bundle}
      disabled={!destination.canEdit || destination.pending || !hasItems}
      onClick={() => destination.set(proposal, !proposal.create_new_bundle)}
    >
      <IconRefreshCw />
    </TipButton>
  )
}

/** Whether this suggestion can be flipped between bundle and collection.
 *
 * An addition puts its files into a bundle that already exists and is not going
 * to become a collection, so the override does not apply to it.
 */
function canConvertKind(proposal: GroupingProposal): boolean {
  return !(proposal.target_bundle_id !== null && !proposal.create_new_bundle)
}

/** Whether turning this bundle into a collection is offered.
 *
 * Mirrors `plan_store._bundle_to_container`, which is the authority (the server
 * refuses regardless). Duplicated here only to decide whether to *show* the
 * control.
 *
 * A bundle that would genuinely divide always may — two or more videos divide per
 * video with sidecars following their own, and a video-less bundle of several
 * files divides per file. A **single subject** may too: the owner may be making a
 * home for siblings they are about to drag in, and refusing that outright left
 * rows with no way to become a collection at all (owner-reported, 2026-07-30).
 *
 * What is refused is a single subject that already sits in a collection for its
 * *own folder*, where another layer would only repeat the name it is inside. That
 * is also what bounds the nesting the owner first reported: the child a conversion
 * creates always lands in exactly that position, so it cannot be converted again.
 */
function canBecomeCollection(
  proposal: GroupingProposal,
  parent: GroupingProposal | undefined,
): boolean {
  const videos = proposal.files.filter(
    (file) => ROLE_MEDIA_KIND[file.proposed_role] === 'video',
  ).length
  const divides = videos >= 2 || (videos === 0 && proposal.files.length >= 2)
  if (divides) return true
  return !(parent?.kind === 'container' && parent.directory === proposal.directory)
}

function kindActionLabel(proposal: GroupingProposal): string {
  return proposal.kind === 'bundle'
    ? 'Make this a collection of bundles instead'
    : 'Make this one bundle instead'
}

/** Flip one suggestion between being a bundle and being a collection.
 *
 * The suggester decides from filenames alone whether a folder holds one thing
 * or several, and Narrow/Widen cannot always overrule it — a folder whose files
 * carry explicit part markers reads as one bundle at every sensitivity. This is
 * the direct override, and it works in both directions so it is not a one-way
 * door. Same compact icon-button shape as the destination toggle beside it.
 */
function KindToggle({ proposal, kind }: { proposal: GroupingProposal; kind: KindControls }) {
  const label = kindActionLabel(proposal)
  return (
    <TipButton
      className="grp-destination"
      tip={label}
      aria-label={label}
      disabled={!kind.canEdit || kind.pending}
      onClick={() => kind.set(proposal)}
    >
      {proposal.kind === 'bundle' ? <IconUngroup /> : <IconGroup />}
    </TipButton>
  )
}

const STEM_MODES: GroupingStemMode[] = ['narrow', 'balanced', 'wide']

/** Render one-step narrower/wider controls for a represented folder.
 *
 * These belong to a **folder**, not to the row they sit on. Exactly one pair is
 * placed per folder (``stemControlOwners``), on whichever row speaks for it —
 * which is a collection row when the folder became a collection and a bundle row
 * when it became one bundle. That made it look like two different controls
 * (owner-reported, 2026-07-30), so the tooltips name the folder and say what
 * will happen to it in plain terms rather than talking about "stem matching".
 *
 * Two compact icon buttons in the same shape as the destination and kind
 * toggles. The current mode is named in each tooltip rather than printed between
 * them: a third piece of text per folder row was more clutter than the
 * three-state value was worth, and the buttons already disable at the ends.
 */
function StemModeControls({ directory, stem }: { directory: string; stem: StemControls }) {
  const current = stem.modes[directory] ?? 'balanced'
  const index = STEM_MODES.indexOf(current)
  const label = directory || 'library root'
  const change = (delta: -1 | 1) => stem.set(directory, STEM_MODES[index + delta]!)
  // "Folder X:" leads both, because the pair applies to the folder rather than to
  // the bundle or collection row it happens to be attached to.
  const scope = `Folder ${label} (matching: ${current})`
  const narrowTip = `${scope} — split into more bundles by matching more of each filename`
  const widenTip = `${scope} — merge into fewer bundles by matching a shorter filename prefix`
  return (
    <span className="grp-stem" aria-label={`Stem matching for ${label}`}>
      <TipButton
        className="grp-destination"
        tip={narrowTip}
        disabled={!stem.canEdit || stem.pending || index === 0}
        aria-label={`Narrow stem matching in ${label}`}
        onClick={() => change(-1)}
      >
        <IconChevronsIn />
      </TipButton>
      <TipButton
        className="grp-destination"
        tip={widenTip}
        disabled={!stem.canEdit || stem.pending || index === STEM_MODES.length - 1}
        aria-label={`Widen stem matching in ${label}`}
        onClick={() => change(1)}
      >
        <IconChevronsOut />
      </TipButton>
    </span>
  )
}

/** Show a compact file count for either destination of an addition proposal */
function additionFileCount(proposal: GroupingProposal): string {
  const count = proposal.files.length
  const files = `${count} ${count === 1 ? 'file' : 'files'}`
  return proposal.create_new_bundle ? files : `${count} new ${count === 1 ? 'file' : 'files'}`
}

/** Edit a title in a field whose rendered width mirrors its live contents. */
function ProposalTitleEditor({
  proposal,
  inputLabel,
  rename,
}: {
  proposal: GroupingProposal
  inputLabel: string
  rename: RenameControls
}) {
  const [value, setValue] = useState(proposal.title ?? '')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // Captured once: this positions the caret on mount only, and re-reading it
  // later would yank the caret back mid-edit.
  const initialCaret = useRef(rename.caretOffset)
  useLayoutEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.focus({ preventScroll: true })
    // Caret where the title was double-clicked, not a select-all: these names are
    // long and mostly right, so the usual edit is a tweak in the middle of one.
    // The offset is a character index taken from the rendered title, so it stays
    // correct even though this textarea lays the text out slightly differently.
    const caret = Math.min(initialCaret.current ?? input.value.length, input.value.length)
    input.setSelectionRange(caret, caret)
  }, [])
  return (
    <span className="grp-title grp-title-editor" data-value={value || ' '}>
      <textarea
        ref={inputRef}
        className="grp-title-input"
        aria-label={inputLabel}
        value={value}
        rows={1}
        disabled={rename.pending}
        onChange={(event) => setValue(event.currentTarget.value)}
        onBlur={(event) => rename.commit(proposal.id, event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            rename.commit(proposal.id, event.currentTarget.value)
          } else if (event.key === 'Escape') {
            event.preventDefault()
            rename.cancel()
          }
        }}
      />
    </span>
  )
}

/** Render a bundle or collection title with inline double-click rename. */
function ProposalTitle({
  proposal,
  isAddition,
  rename,
}: {
  proposal: GroupingProposal
  isAddition: boolean
  rename: RenameControls
}) {
  const displayTitle = proposalDisplayTitle(proposal)
  const kindLabel = proposal.kind === 'container' ? 'collection' : 'bundle'
  const inputLabel = `${kindLabel[0]?.toUpperCase()}${kindLabel.slice(1)} suggestion title`
  const editable = rename.canEdit && !isAddition && proposal.target_collection_id === null
  if (editable && rename.editingId === proposal.id) {
    return <ProposalTitleEditor proposal={proposal} inputLabel={inputLabel} rename={rename} />
  }
  if (editable) {
    return (
      <button
        type="button"
        className="grp-title grp-title--editable"
        aria-label={`Rename ${kindLabel} suggestion ${displayTitle}`}
        title="Double-click to rename"
        onDoubleClick={(event) =>
          rename.start(proposal, caretOffsetFromPoint(event.clientX, event.clientY))
        }
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === 'F2') {
            event.preventDefault()
            // Keyboard entry has no point to aim at; end of the name is the least
            // surprising place to land.
            rename.start(proposal, null)
          }
        }}
      >
        {displayTitle}
      </button>
    )
  }
  return <span className="grp-title">{displayTitle}</span>
}

/** Render a native three-state checkbox for one proposal subtree */
function ProposalCheckbox({
  checked,
  mixed,
  disabled,
  label,
  onChange,
}: {
  checked: boolean
  mixed: boolean
  disabled: boolean
  label: string
  onChange: (checked: boolean) => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = mixed
  }, [mixed])
  return (
    <input
      ref={ref}
      className="grp-check"
      type="checkbox"
      checked={checked}
      disabled={disabled}
      aria-checked={mixed ? 'mixed' : checked}
      onChange={(event) => onChange(event.currentTarget.checked)}
      aria-label={label}
    />
  )
}

/** Make a proposal's collection placement explicit and keyboard accessible */
function ProposalPlacement({
  proposal,
  placement,
}: {
  proposal: GroupingProposal
  placement: PlacementControls
}) {
  const kind = proposal.kind === 'container' ? 'collection' : 'bundle'
  const title = proposalDisplayTitle(proposal)
  const parent = proposal.parent_proposal_id
    ? placement.proposals.get(proposal.parent_proposal_id)
    : undefined
  const currentId = parent ? (parent.target_collection_id ?? undefined) : null
  const suggestedParent = parent && parent.target_collection_id === null ? parent : undefined
  const persistedParent = parent?.target_collection_id ? parent : undefined
  return (
    <GroupingPlacementPicker
      kind={kind}
      title={title}
      currentId={currentId}
      currentLabel={
        suggestedParent
          ? `Suggested: ${proposalDisplayTitle(suggestedParent)}`
          : persistedParent
            ? proposalDisplayTitle(persistedParent)
            : undefined
      }
      currentPath={
        suggestedParent
          ? `Suggested: ${proposalPlacementPath(suggestedParent, placement.proposals)}`
          : persistedParent
            ? proposalPlacementPath(persistedParent, placement.proposals)
            : undefined
      }
      options={placement.options}
      disabled={!placement.canEdit || placement.pending}
      loading={placement.loading}
      error={placement.error}
      onChange={(targetCollectionId) => placement.setCollection(proposal, targetCollectionId)}
    />
  )
}

/** Render one disclosure triangle without starting the draggable parent row */
function ProposalDisclosure({
  subject,
  collapsed,
  collapsible,
  onToggle,
}: {
  subject: string
  collapsed: boolean
  collapsible: boolean
  onToggle: () => void
}) {
  if (!collapsible) return <span className="grp-disclosure-spacer" aria-hidden="true" />
  const action = collapsed ? 'Expand' : 'Collapse'
  return (
    <button
      type="button"
      className="grp-disclosure"
      aria-expanded={!collapsed}
      aria-label={`${action} ${subject}`}
      title={`${action} ${subject}`}
      draggable={false}
      onMouseDown={(event) => event.stopPropagation()}
      onDragStart={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation()
        onToggle()
      }}
    >
      <IconChevron open={!collapsed} />
    </button>
  )
}

function ProposalNode({
  node,
  selection,
  onToggle,
  rename,
  drag,
  placement,
  destination,
  stem,
  stemOwners,
  kind,
  fold,
  parent,
}: {
  node: TreeNode
  selection: Map<string, NodeSelection>
  onToggle: (node: TreeNode, checked: boolean) => void
  rename: RenameControls
  drag: DragControls
  placement: PlacementControls
  destination: DestinationControls
  stem: StemControls
  stemOwners: Map<string, string>
  kind: KindControls
  fold: FoldControls
  /** The enclosing suggestion, which decides whether a single-subject bundle is
   * offered the collection override (see ``canBecomeCollection``). */
  parent?: GroupingProposal
}) {
  const { proposal, children } = node
  const selectionState = selection.get(proposal.id) ?? { total: 0, selected: 0 }
  const checked = selectionState.total > 0 && selectionState.selected === selectionState.total
  const mixed = selectionState.selected > 0 && !checked
  const hasItems = selectionState.total > 0
  const foldKey = proposalKey(proposal)
  const collapsed = fold.collapsed.has(foldKey)
  if (proposal.kind === 'container') {
    const isDropTarget = drag.slot?.kind === 'collection' && drag.slot.proposalId === proposal.id
    const movable = proposal.target_collection_id === null
    return (
      <li className="grp-node grp-node--container">
        <div
          className={`grp-row grp-row--collection${movable ? ' grp-row--draggable' : ''}${isDropTarget ? ' grp-row--drop' : ''}`}
          draggable={movable && drag.canEdit && !drag.pending && rename.editingId !== proposal.id}
          onDragStart={(event) => drag.startProposal(event, proposal)}
          onDragEnd={drag.end}
          onDragOver={(event) => {
            if (drag.item?.kind !== 'proposal' || !drag.canDropProposal(proposal.id)) return
            event.preventDefault()
            event.stopPropagation()
            event.dataTransfer.dropEffect = 'move'
            drag.hover({ kind: 'collection', proposalId: proposal.id })
          }}
          onDrop={(event) => {
            if (drag.item?.kind !== 'proposal' || !drag.canDropProposal(proposal.id)) return
            event.preventDefault()
            event.stopPropagation()
            drag.dropProposal(proposal.id)
          }}
        >
          <ProposalDisclosure
            subject={`collection suggestion ${proposal.title || baseName(proposal.directory) || 'Untitled'}`}
            collapsed={collapsed}
            collapsible={children.length > 0}
            onToggle={() => fold.set(foldKey, !collapsed)}
          />
          <ProposalCheckbox
            checked={checked}
            mixed={mixed}
            disabled={!hasItems}
            onChange={(next) => onToggle(node, next)}
            label={`Select bundles in ${proposal.title || baseName(proposal.directory) || 'collection'}`}
          />
          <span className="grp-kind">
            <IconFolder />
          </span>
          <span className="grp-row__content">
            <ProposalTitle proposal={proposal} isAddition={false} rename={rename} />
            {proposal.target_collection_id !== null && (
              <span className="grp-existing">Existing</span>
            )}
            {proposal.reason && proposal.target_collection_id === null && (
              <span className="grp-reason">{proposal.reason}</span>
            )}
            {proposal.target_collection_id === null && (
              <>
                <ProposalPlacement proposal={proposal} placement={placement} />
                <KindToggle proposal={proposal} kind={kind} />
              </>
            )}
            {stemOwners.has(proposal.id) && (
              <StemModeControls directory={stemOwners.get(proposal.id)!} stem={stem} />
            )}
          </span>
        </div>
        {children.length > 0 && (
          <ul className="grp-children" hidden={collapsed}>
            {children.map((c) => (
              <ProposalNode
                key={c.proposal.id}
                node={c}
                selection={selection}
                onToggle={onToggle}
                rename={rename}
                drag={drag}
                placement={placement}
                destination={destination}
                stem={stem}
                stemOwners={stemOwners}
                kind={kind}
                fold={fold}
                parent={proposal}
              />
            ))}
          </ul>
        )}
      </li>
    )
  }
  const hasDestinationChoice = proposal.target_bundle_id !== null
  const isAddition = hasDestinationChoice && !proposal.create_new_bundle
  const fileListDrop = drag.slot?.kind === 'file-list' && drag.slot.proposalId === proposal.id
  const displayTitle = proposalDisplayTitle(proposal)
  return (
    <li className="grp-node grp-node--bundle">
      <div
        className={`grp-row grp-row--bundle${fileListDrop ? ' grp-row--file-drop' : ''}`}
        // The whole row is the drag affordance — the file rows below already
        // worked this way, which is what made their ⠿ handles redundant. Not
        // draggable while this row's title is being renamed: `draggable` on an
        // ancestor hijacks text selection inside the edit box.
        draggable={drag.canEdit && !drag.pending && rename.editingId !== proposal.id}
        onDragStart={(event) => drag.startProposal(event, proposal)}
        onDragEnd={drag.end}
        onDragOver={(event) => {
          if (drag.item?.kind !== 'file') return
          event.preventDefault()
          event.stopPropagation()
          event.dataTransfer.dropEffect = 'move'
          drag.hover({ kind: 'file-list', proposalId: proposal.id })
        }}
        onDrop={(event) => {
          if (drag.item?.kind !== 'file') return
          event.preventDefault()
          event.stopPropagation()
          drag.dropFile(proposal.id, proposal.files.length)
        }}
      >
        <ProposalDisclosure
          subject={`bundle suggestion ${displayTitle}`}
          collapsed={collapsed}
          collapsible
          onToggle={() => fold.set(foldKey, !collapsed)}
        />
        <ProposalCheckbox
          checked={checked}
          mixed={false}
          disabled={!hasItems}
          onChange={(next) => onToggle(node, next)}
          label={`Accept ${proposal.title || 'bundle'}`}
        />
        {!isAddition && (
          <span className="grp-kind">
            <IconLayers />
          </span>
        )}
        <span className="grp-row__content">
          <span className="grp-title-cluster">
            <ProposalTitle proposal={proposal} isAddition={isAddition} rename={rename} />
            {hasDestinationChoice && (
              <DestinationToggle
                proposal={proposal}
                hasItems={hasItems}
                destination={destination}
              />
            )}
          </span>
          <span className="grp-reason">
            {hasDestinationChoice ? additionFileCount(proposal) : proposal.reason}
          </span>
          <ProposalPlacement proposal={proposal} placement={placement} />
          {canConvertKind(proposal) && hasItems && canBecomeCollection(proposal, parent) && (
            <KindToggle proposal={proposal} kind={kind} />
          )}
          {stemOwners.has(proposal.id) && (
            <StemModeControls directory={stemOwners.get(proposal.id)!} stem={stem} />
          )}
        </span>
      </div>
      <ul
        className={`grp-files${fileListDrop ? ' grp-files--drop' : ''}`}
        aria-label={`Files in ${displayTitle}`}
        hidden={collapsed}
        onDragOver={(event) => {
          if (drag.item?.kind !== 'file') return
          event.preventDefault()
          event.stopPropagation()
          event.dataTransfer.dropEffect = 'move'
          drag.hover({ kind: 'file-list', proposalId: proposal.id })
        }}
        onDrop={(event) => {
          if (drag.item?.kind !== 'file') return
          event.preventDefault()
          event.stopPropagation()
          drag.dropFile(proposal.id, proposal.files.length)
        }}
      >
        {proposal.files.length === 0 && <li className="grp-file-empty">Drop files here</li>}
        {proposal.files.map((f, index) => (
          <li
            key={f.asset_file_id}
            className={`grp-file${drag.canEdit ? ' grp-file--draggable' : ''}${
              drag.item?.kind === 'file' && drag.item.assetFileId === f.asset_file_id
                ? ' grp-file--dragging'
                : ''
            }`}
            draggable={drag.canEdit && !drag.pending}
            data-drop={
              drag.slot?.kind === 'file' &&
              drag.slot.proposalId === proposal.id &&
              drag.slot.assetFileId === f.asset_file_id
                ? drag.slot.before
                  ? 'before'
                  : 'after'
                : undefined
            }
            onDragStart={(event) => drag.startFile(event, proposal.id, f.asset_file_id)}
            onDragEnd={drag.end}
            onDragOver={(event) => {
              if (drag.item?.kind !== 'file') return
              event.preventDefault()
              event.stopPropagation()
              event.dataTransfer.dropEffect = 'move'
              const rect = event.currentTarget.getBoundingClientRect()
              drag.hover({
                kind: 'file',
                proposalId: proposal.id,
                assetFileId: f.asset_file_id,
                before: event.clientY < rect.top + rect.height / 2,
              })
            }}
            onDrop={(event) => {
              if (drag.item?.kind !== 'file') return
              event.preventDefault()
              event.stopPropagation()
              const rect = event.currentTarget.getBoundingClientRect()
              const before = event.clientY < rect.top + rect.height / 2
              drag.dropFile(proposal.id, index + (before ? 0 : 1))
            }}
          >
            <span className="grp-file__name">{baseName(f.relative_path)}</span>
            <span className="grp-file__role">
              {formatFileRole(ROLE_MEDIA_KIND[f.proposed_role] ?? 'other', f.relative_path)}
            </span>
          </li>
        ))}
      </ul>
    </li>
  )
}

function ResultPanel({ result }: { result: GroupingApplyResult }) {
  return (
    <div className="grp-result">
      <p className="grp-result__line">
        Accepted <strong>{result.bundles_confirmed}</strong> bundle(s), created{' '}
        <strong>{result.collections_created}</strong> collection(s), added{' '}
        <strong>{result.files_added_to_bundles}</strong> file(s) to existing bundle(s), linked{' '}
        <strong>{result.subtitles_linked}</strong> subtitle(s).
      </p>
      {result.conflicts.length > 0 && (
        <div className="grp-conflicts">
          <p className="grp-conflicts__head">{result.conflicts.length} item(s) need attention:</p>
          <ul>
            {result.conflicts.map((c, i) => (
              <li key={i}>
                <span className="grp-conflicts__title">{c.title ?? 'A proposal'}</span>: {c.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

export function GroupingReview({
  initialPlanId,
  onClose,
}: {
  initialPlanId?: string | null
  onClose: () => void
}) {
  const plans = useGroupingPlans()
  const [chosenId, setChosenId] = useState<string | null>(initialPlanId ?? null)
  const openPlan = plans.data?.find((p) => p.status === 'open') ?? null
  const planId = chosenId ?? openPlan?.id ?? null
  const plan = useGroupingPlan(planId)
  const collections = useCollections()
  const generate = useGenerateGroupingPlan()
  const rename = useRenameGroupingProposal(planId)
  const moveProposalFile = useMoveGroupingProposalFile(planId)
  const reparentProposal = useReparentGroupingProposal(planId)
  const destination = useSetGroupingProposalDestination(planId)
  const proposalKindMutation = useSetGroupingProposalKind(planId)
  const stemModeMutation = useSetGroupingStemMode(planId)
  const apply = useApplyGroupingPlan()
  const [result, setResult] = useState<GroupingApplyResult | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // Keyed by content rather than proposal id, so a Narrow/Widen regeneration
  // does not silently re-check everything the owner had unchecked. See
  // ``proposalKey``.
  const [deselectedKeys, setDeselectedKeys] = useState<Set<string>>(new Set())
  const [collapsedKeys, setCollapsedKeys] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<{
    id: string
    original: string
    caretOffset: number | null
  } | null>(null)
  const [renameError, setRenameError] = useState<string | null>(null)
  const [dragItem, setDragItem] = useState<ReviewDragItem | null>(null)
  const [dropSlot, setDropSlot] = useState<ReviewDropSlot | null>(null)
  const committingRename = useRef<string | null>(null)

  const tree = useMemo(() => buildTree(plan.data?.proposals ?? []), [plan.data])
  const stemOwners = useMemo(() => stemControlOwners(tree), [tree])
  const bundleProposalIds = useMemo(() => collectBundleIds(tree), [tree])
  const keyById = useMemo(() => collectKeys(tree), [tree])
  const foldKeys = useMemo(() => collectFoldKeys(tree), [tree])
  const placementOptions = useMemo(
    () => collectionPlacementOptions(collections.data ?? []),
    [collections.data],
  )
  const collectionById = useMemo(
    () => new Map((collections.data ?? []).map((collection) => [collection.id, collection])),
    [collections.data],
  )
  const proposalById = useMemo(
    () => new Map((plan.data?.proposals ?? []).map((proposal) => [proposal.id, proposal])),
    [plan.data],
  )
  const emptyBundleIds = useMemo(() => new Set(collectEmptyBundleIds(tree)), [tree])
  const selectedIds = useMemo(
    () => new Set(bundleProposalIds.filter((id) => !deselectedKeys.has(keyById.get(id) ?? id))),
    [bundleProposalIds, deselectedKeys, keyById],
  )
  const nodeSelection = useMemo(() => selectionByNode(tree, selectedIds), [tree, selectedIds])

  const toggleNode = (node: TreeNode, checked: boolean) => {
    const keys = collectBundleIds([node]).map((id) => keyById.get(id) ?? id)
    setDeselectedKeys((prev) => {
      const next = new Set(prev)
      for (const key of keys) {
        if (checked) next.delete(key)
        else next.add(key)
      }
      return next
    })
  }

  const finishGeneration = (generated: GroupingPlan, message: string) => {
    setChosenId(generated.id)
    setResult(null)
    setEditing(null)
    setRenameError(null)
    setDragItem(null)
    setDropSlot(null)
    destination.reset()
    // "Suggest grouping" is an explicit fresh start from the current library
    // state, so stale deselections do not carry into it. Narrow/Widen no longer
    // comes through here at all — it edits the open plan in place.
    setDeselectedKeys(new Set())
    setCollapsedKeys(new Set())
    setNotice(message)
  }

  const onGenerate = () =>
    generate.mutate(plan.data?.stem_modes ?? {}, {
      onSuccess: (p) => {
        finishGeneration(p, 'Suggestions generated from the current library state.')
      },
    })

  // In-place: only the adjusted directory's rows are replaced, so every other
  // suggestion — and every owner edit and checkbox on it — survives untouched.
  const setStemMode = (directory: string, mode: GroupingStemMode) =>
    stemModeMutation.mutate(
      { directory, mode },
      {
        onSuccess: () =>
          setNotice(`${directory || 'Library root'} now uses ${mode} stem matching.`),
      },
    )

  const convertKind = (proposal: GroupingProposal) => {
    const next = proposal.kind === 'bundle' ? 'container' : 'bundle'
    proposalKindMutation.mutate(
      { proposalId: proposal.id, kind: next },
      {
        onSuccess: () =>
          setNotice(
            next === 'container'
              ? `“${proposal.title ?? 'This folder'}” is now a collection of bundles.`
              : `“${proposal.title ?? 'This collection'}” is now a single bundle.`,
          ),
      },
    )
  }

  const startRename = (proposal: GroupingProposal, caretOffset: number | null = null) => {
    rename.reset()
    setRenameError(null)
    setEditing({ id: proposal.id, original: proposal.title?.trim() ?? '', caretOffset })
  }

  const cancelRename = () => {
    if (rename.isPending) return
    rename.reset()
    setRenameError(null)
    setEditing(null)
  }

  const commitRename = (proposalId: string, rawTitle: string) => {
    if (editing?.id !== proposalId || committingRename.current === proposalId) return
    const title = rawTitle.trim()
    if (!title) {
      const proposal = plan.data?.proposals.find((item) => item.id === proposalId)
      const kindLabel = proposal?.kind === 'container' ? 'Collection' : 'Bundle'
      setRenameError(`${kindLabel} suggestion title cannot be empty.`)
      return
    }
    if (title === editing.original) {
      cancelRename()
      return
    }

    committingRename.current = proposalId
    setRenameError(null)
    rename.mutate(
      { proposalId, title },
      {
        onSuccess: () => setEditing(null),
        onError: (failure) =>
          setRenameError(
            failure instanceof Error ? failure.message : 'Could not rename suggestion.',
          ),
        onSettled: () => {
          committingRename.current = null
        },
      },
    )
  }

  const onApply = () => {
    if (planId)
      apply.mutate(
        { id: planId, proposalIds: [...selectedIds] },
        {
          onSuccess: (r) => {
            setNotice(null)
            setResult(r)
          },
        },
      )
  }

  const setDestination = (proposal: GroupingProposal, createNewBundle: boolean) => {
    destination.mutate(
      { proposalId: proposal.id, createNewBundle },
      {
        onSuccess: () =>
          setNotice(
            createNewBundle
              ? 'The files will create a new bundle.'
              : `The files will be added to ${targetTitle(proposal)}.`,
          ),
      },
    )
  }

  const clearDrag = () => {
    setDragItem(null)
    setDropSlot(null)
  }

  const startFileDrag = (event: DragEvent, proposalId: string, assetFileId: string) => {
    event.stopPropagation()
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', assetFileId)
    setDragItem({ kind: 'file', proposalId, assetFileId })
    setDropSlot(null)
  }

  const startProposalDrag = (event: DragEvent, proposal: GroupingProposal) => {
    event.stopPropagation()
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', proposal.id)
    setDragItem({ kind: 'proposal', proposalId: proposal.id, proposalKind: proposal.kind })
    setDropSlot(null)
  }

  const canPlaceProposal = (proposalId: string, parentProposalId: string | null) => {
    if (parentProposalId === null) return true
    let current = proposalById.get(parentProposalId)
    const seen = new Set<string>()
    while (current) {
      if (current.id === proposalId || seen.has(current.id)) return false
      seen.add(current.id)
      current = proposalById.get(current.parent_proposal_id ?? '')
    }
    return true
  }

  const setPlacement = (
    proposal: GroupingProposal,
    parentProposalId: string | null,
    targetCollectionId: string | null = null,
  ) => {
    reparentProposal.mutate(
      { proposalId: proposal.id, parentProposalId, targetCollectionId },
      {
        onSuccess: () => {
          const kind = proposal.kind === 'container' ? 'Collection' : 'Bundle'
          const parent = parentProposalId ? proposalById.get(parentProposalId) : null
          const collection = targetCollectionId ? collectionById.get(targetCollectionId) : null
          setNotice(
            collection
              ? `${kind} moved into “${collection.name}”.`
              : parent
                ? `${kind} moved into “${parent.title ?? 'collection'}”.`
                : `${kind} moved to the top level.`,
          )
        },
      },
    )
  }

  const rememberEmptiedSuggestions = (updated: GroupingProposal[]) => {
    if (!plan.data) return
    const byId = new Map(updated.map((proposal) => [proposal.id, proposal]))
    const projected = plan.data.proposals.map((proposal) => byId.get(proposal.id) ?? proposal)
    const projectedTree = buildTree(projected)
    const projectedKeys = collectKeys(projectedTree)
    const emptied = collectEmptyBundleIds(projectedTree)
      .filter((proposalId) => !emptyBundleIds.has(proposalId))
      .map((proposalId) => projectedKeys.get(proposalId))
      .filter((key): key is string => key !== undefined)
    if (emptied.length === 0) return
    setDeselectedKeys((current) => new Set([...current, ...emptied]))
  }

  const dropFile = (targetProposalId: string, targetIndex: number) => {
    if (dragItem?.kind !== 'file') return
    const { proposalId, assetFileId } = dragItem
    moveProposalFile.mutate(
      {
        sourceProposalId: proposalId,
        assetFileId,
        targetProposalId,
        targetIndex,
      },
      {
        onSuccess: (updated) => {
          rememberEmptiedSuggestions(updated)
          setNotice('Bundle file arrangement updated.')
        },
      },
    )
    clearDrag()
  }

  const dropProposal = (parentProposalId: string | null) => {
    if (dragItem?.kind !== 'proposal' || !canPlaceProposal(dragItem.proposalId, parentProposalId))
      return
    const proposal = proposalById.get(dragItem.proposalId)
    if (proposal) setPlacement(proposal, parentProposalId)
    clearDrag()
  }

  const status = plan.data?.status
  const applied = status === 'applied' || result !== null
  const busy =
    generate.isPending ||
    rename.isPending ||
    destination.isPending ||
    moveProposalFile.isPending ||
    reparentProposal.isPending ||
    proposalKindMutation.isPending ||
    stemModeMutation.isPending ||
    apply.isPending
  const actionBlocked = busy || editing !== null
  const error = (generate.error ??
    destination.error ??
    moveProposalFile.error ??
    reparentProposal.error ??
    proposalKindMutation.error ??
    stemModeMutation.error ??
    apply.error) as Error | null
  const selectedCount = selectedIds.size
  const someFolded = foldKeys.some((key) => collapsedKeys.has(key))
  const allFolded = foldKeys.length > 0 && foldKeys.every((key) => collapsedKeys.has(key))
  const renameControls: RenameControls = {
    canEdit: status === 'open',
    editingId: editing?.id ?? null,
    pending: rename.isPending,
    start: startRename,
    caretOffset: editing?.caretOffset ?? null,
    commit: commitRename,
    cancel: cancelRename,
  }
  const dragControls: DragControls = {
    canEdit: status === 'open' && editing === null,
    pending: busy,
    item: dragItem,
    slot: dropSlot,
    startFile: startFileDrag,
    startProposal: startProposalDrag,
    hover: setDropSlot,
    dropFile,
    canDropProposal: (parentProposalId) =>
      dragItem?.kind === 'proposal' && canPlaceProposal(dragItem.proposalId, parentProposalId),
    dropProposal,
    end: clearDrag,
  }
  const placementControls: PlacementControls = {
    canEdit: status === 'open' && editing === null,
    pending: busy,
    loading: collections.isLoading,
    error: collections.isError,
    options: placementOptions,
    proposals: proposalById,
    setCollection: (proposal, targetCollectionId) =>
      setPlacement(proposal, null, targetCollectionId),
  }
  const destinationControls: DestinationControls = {
    canEdit: status === 'open' && editing === null,
    pending: busy,
    set: setDestination,
  }
  const stemControls: StemControls = {
    canEdit: status === 'open' && editing === null,
    pending: busy,
    modes: plan.data?.stem_modes ?? {},
    set: setStemMode,
  }
  const kindControls: KindControls = {
    canEdit: status === 'open' && editing === null,
    pending: busy,
    set: convertKind,
  }
  const foldControls: FoldControls = {
    collapsed: collapsedKeys,
    set: (key, collapsed) =>
      setCollapsedKeys((current) => {
        const next = new Set(current)
        if (collapsed) next.add(key)
        else next.delete(key)
        return next
      }),
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal grp-modal"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="modal__head">
          <h2>Suggest grouping</h2>
          <button className="modal__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="modal__body grp-body">
          {/* Deliberately short. The paragraph this replaced documented every
              affordance in the dialog, which put a wall of prose above the thing
              the owner came to read (owner-reported, 2026-07-29). Each control
              now carries its own tooltip, so only what a row cannot say for
              itself is left: what is in scope, what Accept does, and the safety
              guarantee. */}
          <p className="grp-intro">
            Proposed grouping for unbundled files and new additions.{' '}
            <strong>Nothing on disk changes.</strong>
          </p>
          <ul className="grp-intro-points">
            <li>Collection checkboxes select their bundles; the shown hierarchy sets placement.</li>
            <li>Drag files between bundles, or place new bundles and collections explicitly.</li>
            <li>Reflects the last scan — run Scan new files if the folder changed since.</li>
          </ul>

          {error && <div className="grp-error">{error.message}</div>}
          {renameError && <div className="grp-error">{renameError}</div>}
          {notice && !result && (
            <div className="grp-notice" role="status">
              {notice}
            </div>
          )}

          {result && <ResultPanel result={result} />}

          {!result && plan.data && tree.length > 0 && (
            <>
              <div className="grp-selectbar">
                <div className="grp-selectbar__group">
                  <span>
                    {selectedCount} {selectedCount === 1 ? 'bundle' : 'bundles'} selected
                  </span>
                  <button
                    type="button"
                    className="btn btn--compact"
                    onClick={() => setDeselectedKeys(new Set())}
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    className="btn btn--compact"
                    onClick={() =>
                      setDeselectedKeys(
                        new Set(bundleProposalIds.map((id) => keyById.get(id) ?? id)),
                      )
                    }
                  >
                    Deselect all
                  </button>
                </div>
                <div className="grp-selectbar__group">
                  <button
                    type="button"
                    className="btn btn--compact"
                    disabled={allFolded}
                    onClick={() => setCollapsedKeys(new Set(foldKeys))}
                  >
                    Collapse all
                  </button>
                  <button
                    type="button"
                    className="btn btn--compact"
                    disabled={!someFolded}
                    onClick={() => setCollapsedKeys(new Set())}
                  >
                    Expand all
                  </button>
                </div>
              </div>
              {dragItem?.kind === 'proposal' && (
                <div
                  className={`grp-root-drop${dropSlot?.kind === 'root' ? ' grp-root-drop--over' : ''}`}
                  onDragOver={(event) => {
                    if (!canPlaceProposal(dragItem.proposalId, null)) return
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                    setDropSlot({ kind: 'root' })
                  }}
                  onDrop={(event) => {
                    event.preventDefault()
                    dropProposal(null)
                  }}
                >
                  Drop here to move the {dragItem.proposalKind} to the top level
                </div>
              )}
              <ul className="grp-tree">
                {tree.map((node) => (
                  <ProposalNode
                    key={node.proposal.id}
                    node={node}
                    selection={nodeSelection}
                    onToggle={toggleNode}
                    rename={renameControls}
                    drag={dragControls}
                    placement={placementControls}
                    destination={destinationControls}
                    stem={stemControls}
                    stemOwners={stemOwners}
                    kind={kindControls}
                    fold={foldControls}
                  />
                ))}
              </ul>
            </>
          )}

          {!result && (!plan.data || tree.length === 0) && !plan.isLoading && (
            <div className="grp-empty">
              {planId
                ? 'Nothing to group — there are no unbundled files awaiting suggestions.'
                : 'No suggestions yet. Click “Suggest grouping” to analyze the library.'}
            </div>
          )}
        </div>

        <div className="modal__foot grp-foot">
          <button className="btn" onClick={onGenerate} disabled={actionBlocked}>
            {generate.isPending ? 'Suggesting…' : 'Suggest grouping'}
          </button>
          <div className="grp-foot__spacer" />
          {applied ? (
            <button className="btn btn--primary" onClick={onClose}>
              Done
            </button>
          ) : (
            <button
              className="btn btn--primary"
              onClick={onApply}
              disabled={actionBlocked || !plan.data || selectedCount === 0 || status !== 'open'}
            >
              {apply.isPending ? 'Accepting…' : 'Accept selected'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

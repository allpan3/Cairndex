import { type DragEvent, useMemo, useRef, useState } from 'react'

import type { GroupingApplyResult, GroupingProposal } from '../api/client'
import {
  useApplyGroupingPlan,
  useGenerateGroupingPlan,
  useGroupingPlan,
  useGroupingPlans,
  useMoveGroupingProposalFile,
  useRenameGroupingProposal,
  useReparentGroupingProposal,
  useSetGroupingProposalDestination,
} from '../api/hooks'
import { IconRefreshCw } from './icons'

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
const ROLE_LABEL: Record<string, string> = {
  primary_video: 'video',
  video_part: 'video part',
  alternate_version: 'alt version',
  cover: 'cover',
  image: 'image',
  screenshot: 'screenshot',
  album_image: 'image',
  subtitle: 'subtitle',
  attachment: 'file',
  generated_derivative: 'derivative',
  other: 'file',
}

function baseName(path: string): string {
  return path.split('/').pop() ?? path
}

interface TreeNode {
  proposal: GroupingProposal
  children: TreeNode[]
}

/** Coordinate one persisted inline rename across the recursive proposal tree. */
interface RenameControls {
  canEdit: boolean
  editingId: string | null
  pending: boolean
  start: (proposal: GroupingProposal) => void
  commit: (proposalId: string, title: string) => void
  cancel: () => void
}

/** Coordinate one persisted existing-versus-new bundle choice. */
interface DestinationControls {
  canEdit: boolean
  pending: boolean
  set: (proposal: GroupingProposal, createNewBundle: boolean) => void
}

type ReviewDragItem =
  | { kind: 'file'; proposalId: string; assetFileId: string }
  | { kind: 'bundle'; proposalId: string }

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
  startBundle: (event: DragEvent, proposalId: string) => void
  hover: (slot: ReviewDropSlot) => void
  dropFile: (targetProposalId: string, targetIndex: number) => void
  dropBundle: (parentProposalId: string | null) => void
  end: () => void
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

function collectIds(nodes: TreeNode[]): string[] {
  return nodes.flatMap((node) => [node.proposal.id, ...collectIds(node.children)])
}

/** Determine whether a proposal still contains any file-backed item. */
function nodeHasItems(node: TreeNode): boolean {
  return node.proposal.kind === 'bundle'
    ? node.proposal.files.length > 0
    : node.children.some(nodeHasItems)
}

/** Collect suggestions that became empty after a review drag. */
function collectEmptyIds(nodes: TreeNode[]): string[] {
  return nodes.flatMap((node) => [
    ...(nodeHasItems(node) ? [] : [node.proposal.id]),
    ...collectEmptyIds(node.children),
  ])
}

/** Resolve the stable destination label, including legacy open-plan fallback. */
function targetTitle(proposal: GroupingProposal): string {
  return proposal.target_bundle_title || proposal.title || 'bundle'
}

/** Build the title shown for the proposal's current destination mode. */
function proposalDisplayTitle(proposal: GroupingProposal): string {
  return proposal.target_bundle_id && !proposal.create_new_bundle
    ? `Add to 🎬 ${targetTitle(proposal)}`
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
    <button
      type="button"
      className="grp-destination tip"
      aria-label={label}
      aria-pressed={proposal.create_new_bundle}
      data-tip={label}
      disabled={destination.pending || !hasItems}
      onClick={() => destination.set(proposal, !proposal.create_new_bundle)}
    >
      <IconRefreshCw />
    </button>
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
  return (
    <span className="grp-title grp-title-editor" data-value={value || ' '}>
      <input
        className="grp-title-input"
        aria-label={inputLabel}
        value={value}
        autoFocus
        disabled={rename.pending}
        onChange={(event) => setValue(event.currentTarget.value)}
        onFocus={(event) => event.currentTarget.select()}
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
  const editable = rename.canEdit && !isAddition
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
        onDoubleClick={() => rename.start(proposal)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === 'F2') {
            event.preventDefault()
            rename.start(proposal)
          }
        }}
      >
        {displayTitle}
      </button>
    )
  }
  return <span className="grp-title">{displayTitle}</span>
}

function ProposalNode({
  node,
  selectedIds,
  onToggle,
  rename,
  drag,
  destination,
}: {
  node: TreeNode
  selectedIds: Set<string>
  onToggle: (node: TreeNode, checked: boolean) => void
  rename: RenameControls
  drag: DragControls
  destination: DestinationControls
}) {
  const { proposal, children } = node
  const checked = selectedIds.has(proposal.id)
  const hasItems = nodeHasItems(node)
  if (proposal.kind === 'container') {
    const isDropTarget = drag.slot?.kind === 'collection' && drag.slot.proposalId === proposal.id
    return (
      <li className="grp-node grp-node--container">
        <div
          className={`grp-row grp-row--collection${isDropTarget ? ' grp-row--drop' : ''}`}
          onDragOver={(event) => {
            if (drag.item?.kind !== 'bundle') return
            event.preventDefault()
            event.stopPropagation()
            event.dataTransfer.dropEffect = 'move'
            drag.hover({ kind: 'collection', proposalId: proposal.id })
          }}
          onDrop={(event) => {
            if (drag.item?.kind !== 'bundle') return
            event.preventDefault()
            event.stopPropagation()
            drag.dropBundle(proposal.id)
          }}
        >
          <input
            className="grp-check"
            type="checkbox"
            checked={checked}
            disabled={!hasItems}
            onChange={(e) => onToggle(node, e.currentTarget.checked)}
            aria-label={`Accept ${proposal.title || baseName(proposal.directory) || 'collection'}`}
          />
          <span className="grp-kind">📁</span>
          <span className="grp-row__content">
            <ProposalTitle proposal={proposal} isAddition={false} rename={rename} />
            {proposal.reason && <span className="grp-reason">{proposal.reason}</span>}
          </span>
        </div>
        {children.length > 0 && (
          <ul className="grp-children">
            {children.map((c) => (
              <ProposalNode
                key={c.proposal.id}
                node={c}
                selectedIds={selectedIds}
                onToggle={onToggle}
                rename={rename}
                drag={drag}
                destination={destination}
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
      <div className="grp-row grp-row--bundle">
        <input
          className="grp-check"
          type="checkbox"
          checked={checked}
          disabled={!hasItems}
          onChange={(e) => onToggle(node, e.currentTarget.checked)}
          aria-label={`Accept ${proposal.title || 'bundle'}`}
        />
        {drag.canEdit && (
          <button
            type="button"
            className="grp-drag-handle"
            draggable={!drag.pending}
            disabled={drag.pending}
            aria-label={`Drag bundle ${displayTitle}`}
            title="Drag bundle into a collection"
            onDragStart={(event) => drag.startBundle(event, proposal.id)}
            onDragEnd={drag.end}
          >
            ⠿
          </button>
        )}
        {!isAddition && <span className="grp-kind">🎬</span>}
        <span className="grp-row__content">
          <span className="grp-title-cluster">
            <ProposalTitle proposal={proposal} isAddition={isAddition} rename={rename} />
            {hasDestinationChoice && destination.canEdit && (
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
        </span>
      </div>
      <ul
        className={`grp-files${fileListDrop ? ' grp-files--drop' : ''}`}
        aria-label={`Files in ${displayTitle}`}
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
            className={`grp-file${
              drag.item?.kind === 'file' && drag.item.assetFileId === f.asset_file_id
                ? ' grp-file--dragging'
                : ''
            }`}
            data-drop={
              drag.slot?.kind === 'file' &&
              drag.slot.proposalId === proposal.id &&
              drag.slot.assetFileId === f.asset_file_id
                ? drag.slot.before
                  ? 'before'
                  : 'after'
                : undefined
            }
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
            {drag.canEdit && (
              <button
                type="button"
                className="grp-drag-handle grp-drag-handle--file"
                draggable={!drag.pending}
                disabled={drag.pending}
                aria-label={`Drag file ${baseName(f.relative_path)}`}
                title="Drag to reorder or move into another bundle"
                onDragStart={(event) => drag.startFile(event, proposal.id, f.asset_file_id)}
                onDragEnd={drag.end}
              >
                ⠿
              </button>
            )}
            <span className="grp-file__name">{baseName(f.relative_path)}</span>
            <span className="grp-file__role">{ROLE_LABEL[f.proposed_role] ?? f.proposed_role}</span>
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
  const generate = useGenerateGroupingPlan()
  const rename = useRenameGroupingProposal(planId)
  const moveProposalFile = useMoveGroupingProposalFile(planId)
  const reparentProposal = useReparentGroupingProposal(planId)
  const destination = useSetGroupingProposalDestination(planId)
  const apply = useApplyGroupingPlan()
  const [result, setResult] = useState<GroupingApplyResult | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [deselectedIds, setDeselectedIds] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<{ id: string; original: string } | null>(null)
  const [renameError, setRenameError] = useState<string | null>(null)
  const [dragItem, setDragItem] = useState<ReviewDragItem | null>(null)
  const [dropSlot, setDropSlot] = useState<ReviewDropSlot | null>(null)
  const committingRename = useRef<string | null>(null)

  const tree = useMemo(() => buildTree(plan.data?.proposals ?? []), [plan.data])
  const allProposalIds = useMemo(() => collectIds(tree), [tree])
  const emptyProposalIds = useMemo(() => new Set(collectEmptyIds(tree)), [tree])
  const selectedIds = useMemo(
    () =>
      new Set(allProposalIds.filter((id) => !deselectedIds.has(id) && !emptyProposalIds.has(id))),
    [allProposalIds, deselectedIds, emptyProposalIds],
  )

  const toggleNode = (node: TreeNode, checked: boolean) => {
    const ids = collectIds([node])
    setDeselectedIds((prev) => {
      const next = new Set(prev)
      for (const id of ids) {
        if (checked) next.delete(id)
        else next.add(id)
      }
      return next
    })
  }

  const onGenerate = () =>
    generate.mutate(undefined, {
      onSuccess: (p) => {
        setChosenId(p.id)
        setResult(null)
        setEditing(null)
        setRenameError(null)
        setDragItem(null)
        setDropSlot(null)
        destination.reset()
        setDeselectedIds(new Set())
        setNotice('Suggestions generated from the current library state.')
      },
    })

  const startRename = (proposal: GroupingProposal) => {
    rename.reset()
    setRenameError(null)
    setEditing({ id: proposal.id, original: proposal.title?.trim() ?? '' })
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

  const startBundleDrag = (event: DragEvent, proposalId: string) => {
    event.stopPropagation()
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', proposalId)
    setDragItem({ kind: 'bundle', proposalId })
    setDropSlot(null)
  }

  const rememberEmptiedSuggestions = (updated: GroupingProposal[]) => {
    if (!plan.data) return
    const byId = new Map(updated.map((proposal) => [proposal.id, proposal]))
    const projected = plan.data.proposals.map((proposal) => byId.get(proposal.id) ?? proposal)
    const emptied = collectEmptyIds(buildTree(projected)).filter(
      (proposalId) => !emptyProposalIds.has(proposalId),
    )
    if (emptied.length === 0) return
    setDeselectedIds((current) => new Set([...current, ...emptied]))
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

  const dropBundle = (parentProposalId: string | null) => {
    if (dragItem?.kind !== 'bundle') return
    reparentProposal.mutate(
      { proposalId: dragItem.proposalId, parentProposalId },
      {
        onSuccess: (updated) => {
          rememberEmptiedSuggestions([updated])
          setNotice(
            parentProposalId
              ? 'Bundle moved into the collection suggestion.'
              : 'Bundle moved to the top level.',
          )
        },
      },
    )
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
    apply.isPending
  const actionBlocked = busy || editing !== null
  const error = (generate.error ??
    destination.error ??
    moveProposalFile.error ??
    reparentProposal.error ??
    apply.error) as Error | null
  const selectedCount = selectedIds.size
  const renameControls: RenameControls = {
    canEdit: status === 'open',
    editingId: editing?.id ?? null,
    pending: rename.isPending,
    start: startRename,
    commit: commitRename,
    cancel: cancelRename,
  }
  const dragControls: DragControls = {
    canEdit: status === 'open',
    pending: moveProposalFile.isPending || reparentProposal.isPending || destination.isPending,
    item: dragItem,
    slot: dropSlot,
    startFile: startFileDrag,
    startBundle: startBundleDrag,
    hover: setDropSlot,
    dropFile,
    dropBundle,
    end: clearDrag,
  }
  const destinationControls: DestinationControls = {
    canEdit: status === 'open' && editing === null,
    pending: busy,
    set: setDestination,
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
          <p className="grp-intro">
            Suggestions cover still-unbundled files and new additions. Review the proposed bundles
            and collections, drag files between bundles or bundles into collections, then accept
            only the checked items. Double-click either title to rename it. Newly confirmed bundles
            join their selected parent collection; existing confirmed bundles stay untouched unless
            a reviewed addition targets them. Nothing on disk changes.
          </p>

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
                <span>{selectedCount} selected</span>
                <button className="btn btn--compact" onClick={() => setDeselectedIds(new Set())}>
                  Select all
                </button>
                <button
                  className="btn btn--compact"
                  onClick={() => setDeselectedIds(new Set(allProposalIds))}
                >
                  Deselect all
                </button>
              </div>
              {dragItem?.kind === 'bundle' && (
                <div
                  className={`grp-root-drop${dropSlot?.kind === 'root' ? ' grp-root-drop--over' : ''}`}
                  onDragOver={(event) => {
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                    setDropSlot({ kind: 'root' })
                  }}
                  onDrop={(event) => {
                    event.preventDefault()
                    dropBundle(null)
                  }}
                >
                  Drop here to leave the bundle outside a collection
                </div>
              )}
              <ul className="grp-tree">
                {tree.map((node) => (
                  <ProposalNode
                    key={node.proposal.id}
                    node={node}
                    selectedIds={selectedIds}
                    onToggle={toggleNode}
                    rename={renameControls}
                    drag={dragControls}
                    destination={destinationControls}
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

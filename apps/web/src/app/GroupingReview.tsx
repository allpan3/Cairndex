import { useMemo, useRef, useState } from 'react'

import type { GroupingApplyResult, GroupingProposal } from '../api/client'
import {
  useApplyGroupingPlan,
  useGenerateGroupingPlan,
  useGroupingPlan,
  useGroupingPlans,
  useRenameGroupingProposal,
} from '../api/hooks'

/**
 * Review grouping suggestions and apply them (ADR-0009 phase 4).
 *
 * The scanner over-fragments a real library (one bundle per file). This surface
 * shows the suggester's plan — proposed bundles and the logical containers that
 * would hold them, with each file's role, a confidence, and a reason — and lets
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

function Confidence({ value }: { value: number }) {
  const pct = Math.round(value * 100)
  const level = value >= 0.8 ? 'high' : value >= 0.6 ? 'mid' : 'low'
  return (
    <span className={`grp-conf grp-conf--${level}`} title={`${pct}% confidence`}>
      {pct}%
    </span>
  )
}

/** Render a bundle suggestion title with an inline double-click rename field. */
function BundleTitle({
  proposal,
  isAddition,
  rename,
}: {
  proposal: GroupingProposal
  isAddition: boolean
  rename: RenameControls
}) {
  const displayTitle = proposal.title || '(untitled)'
  const editable = rename.canEdit && !isAddition
  if (editable && rename.editingId === proposal.id) {
    return (
      <input
        className="grp-title grp-title-input"
        aria-label="Bundle suggestion title"
        defaultValue={proposal.title ?? ''}
        autoFocus
        disabled={rename.pending}
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
    )
  }
  if (editable) {
    return (
      <button
        type="button"
        className="grp-title grp-title--editable"
        aria-label={`Rename bundle suggestion ${displayTitle}`}
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
  return <span className="grp-title">{isAddition ? `Add to ${displayTitle}` : displayTitle}</span>
}

function ProposalNode({
  node,
  selectedIds,
  onToggle,
  rename,
}: {
  node: TreeNode
  selectedIds: Set<string>
  onToggle: (node: TreeNode, checked: boolean) => void
  rename: RenameControls
}) {
  const { proposal, children } = node
  const checked = selectedIds.has(proposal.id)
  if (proposal.kind === 'container') {
    return (
      <li className="grp-node grp-node--container">
        <div className="grp-row">
          <input
            className="grp-check"
            type="checkbox"
            checked={checked}
            onChange={(e) => onToggle(node, e.currentTarget.checked)}
            aria-label={`Accept ${proposal.title || baseName(proposal.directory) || 'collection'}`}
          />
          <span className="grp-kind">📁</span>
          <span className="grp-title">
            {proposal.title || baseName(proposal.directory) || 'Collection'}
          </span>
          <Confidence value={proposal.confidence} />
          {proposal.reason && <span className="grp-reason">{proposal.reason}</span>}
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
              />
            ))}
          </ul>
        )}
      </li>
    )
  }
  const isAddition = proposal.target_bundle_id !== null
  return (
    <li className="grp-node grp-node--bundle">
      <div className="grp-row">
        <input
          className="grp-check"
          type="checkbox"
          checked={checked}
          onChange={(e) => onToggle(node, e.currentTarget.checked)}
          aria-label={`Accept ${proposal.title || 'bundle'}`}
        />
        <span className="grp-kind">{isAddition ? '➕' : '🎬'}</span>
        <BundleTitle proposal={proposal} isAddition={isAddition} rename={rename} />
        <Confidence value={proposal.confidence} />
        {proposal.reason && <span className="grp-reason">{proposal.reason}</span>}
      </div>
      <ul className="grp-files">
        {proposal.files.map((f) => (
          <li key={f.asset_file_id} className="grp-file">
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
  const apply = useApplyGroupingPlan()
  const [result, setResult] = useState<GroupingApplyResult | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [deselectedIds, setDeselectedIds] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<{ id: string; original: string } | null>(null)
  const [renameError, setRenameError] = useState<string | null>(null)
  const committingRename = useRef<string | null>(null)

  const tree = useMemo(() => buildTree(plan.data?.proposals ?? []), [plan.data])
  const allProposalIds = useMemo(() => collectIds(tree), [tree])
  const selectedIds = useMemo(
    () => new Set(allProposalIds.filter((id) => !deselectedIds.has(id))),
    [allProposalIds, deselectedIds],
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
      setRenameError('Bundle suggestion title cannot be empty.')
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

  const status = plan.data?.status
  const applied = status === 'applied' || result !== null
  const busy = generate.isPending || rename.isPending || apply.isPending
  const actionBlocked = busy || editing !== null
  const error = (generate.error ?? apply.error) as Error | null
  const selectedCount = selectedIds.size
  const renameControls: RenameControls = {
    canEdit: status === 'open',
    editingId: editing?.id ?? null,
    pending: rename.isPending,
    start: startRename,
    commit: commitRename,
    cancel: cancelRename,
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
            Suggestions cover every bundle that isn’t filed into a collection yet — including one
            whose collections you later removed — plus any still-unbundled files. Review the
            proposed bundles and collections, then accept only the checked items. Bundles already
            filed into a collection are left untouched. Nothing on disk changes.
          </p>

          {error && <div className="grp-error">{error.message}</div>}
          {renameError && <div className="grp-error">{renameError}</div>}
          {notice && !result && <div className="grp-notice">{notice}</div>}

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
              <ul className="grp-tree">
                {tree.map((node) => (
                  <ProposalNode
                    key={node.proposal.id}
                    node={node}
                    selectedIds={selectedIds}
                    onToggle={toggleNode}
                    rename={renameControls}
                  />
                ))}
              </ul>
            </>
          )}

          {!result && (!plan.data || tree.length === 0) && !plan.isLoading && (
            <div className="grp-empty">
              {planId
                ? 'Nothing to group — every bundle is already filed into a collection.'
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

import { useMemo, useState } from 'react'

import type { GroupingApplyResult, GroupingProposal } from '../api/client'
import {
  useApplyGroupingPlan,
  useGenerateGroupingPlan,
  useGroupingPlan,
  useGroupingPlans,
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

function Confidence({ value }: { value: number }) {
  const pct = Math.round(value * 100)
  const level = value >= 0.8 ? 'high' : value >= 0.6 ? 'mid' : 'low'
  return (
    <span className={`grp-conf grp-conf--${level}`} title={`${pct}% confidence`}>
      {pct}%
    </span>
  )
}

function ProposalNode({ node }: { node: TreeNode }) {
  const { proposal, children } = node
  if (proposal.kind === 'container') {
    return (
      <li className="grp-node grp-node--container">
        <div className="grp-row">
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
              <ProposalNode key={c.proposal.id} node={c} />
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
        <span className="grp-kind">{isAddition ? '➕' : '🎬'}</span>
        <span className="grp-title">
          {isAddition ? `Add to ${proposal.title || 'bundle'}` : proposal.title || '(untitled)'}
        </span>
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
        Confirmed <strong>{result.bundles_confirmed}</strong> bundle(s), created{' '}
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

export function GroupingReview({ onClose }: { onClose: () => void }) {
  const plans = useGroupingPlans()
  const [chosenId, setChosenId] = useState<string | null>(null)
  const openPlan = plans.data?.find((p) => p.status === 'open') ?? null
  const planId = chosenId ?? openPlan?.id ?? null
  const plan = useGroupingPlan(planId)
  const generate = useGenerateGroupingPlan()
  const apply = useApplyGroupingPlan()
  const [result, setResult] = useState<GroupingApplyResult | null>(null)

  const tree = useMemo(() => buildTree(plan.data?.proposals ?? []), [plan.data])

  const onGenerate = () =>
    generate.mutate(undefined, {
      onSuccess: (p) => {
        setChosenId(p.id)
        setResult(null)
      },
    })

  const onApply = () => {
    if (planId) apply.mutate(planId, { onSuccess: setResult })
  }

  const status = plan.data?.status
  const applied = status === 'applied' || result !== null
  const busy = generate.isPending || apply.isPending
  const error = (generate.error ?? apply.error) as Error | null

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal grp-modal"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="modal__head">
          <h2>Review grouping</h2>
          <button className="modal__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="modal__body grp-body">
          <p className="grp-intro">
            A scan links files but groups one bundle per file. Suggest a grouping, review it, then
            apply — confirming bundles, creating collections, and linking subtitles. Nothing on disk
            changes.
          </p>

          {error && <div className="grp-error">{error.message}</div>}

          {result && <ResultPanel result={result} />}

          {!result && plan.data && tree.length > 0 && (
            <ul className="grp-tree">
              {tree.map((node) => (
                <ProposalNode key={node.proposal.id} node={node} />
              ))}
            </ul>
          )}

          {!result && (!plan.data || tree.length === 0) && !plan.isLoading && (
            <div className="grp-empty">
              {planId
                ? 'This plan has no suggestions. Scan the library, then suggest again.'
                : 'No suggestions yet. Click “Suggest grouping” to analyze the library.'}
            </div>
          )}
        </div>

        <div className="modal__foot grp-foot">
          <button className="btn" onClick={onGenerate} disabled={busy}>
            {generate.isPending ? 'Suggesting…' : applied ? 'Suggest again' : 'Suggest grouping'}
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
              disabled={busy || !plan.data || tree.length === 0 || status !== 'open'}
            >
              {apply.isPending ? 'Applying…' : 'Apply grouping'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

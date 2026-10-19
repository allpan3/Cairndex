import type { GroupingNode } from '../../api/grouping'
import { IconChevron, IconLayers } from '../icons'
import { GroupingCheck } from './GroupingNodeRow'
import { GroupingStemControls } from './GroupingStemControls'
import { groupingFileSummary } from './groupingRows'
import type { GroupingWorkspaceState } from './useGroupingWorkspace'

export function GroupingRollup({
  nodes,
  state,
  expand,
  stem,
}: {
  nodes: GroupingNode[]
  state: GroupingWorkspaceState
  expand: () => void
  stem?: GroupingNode
}) {
  const first = nodes[0]!
  const last = nodes.at(-1)!
  const total = nodes.reduce((sum, node) => sum + node.files, 0)
  const selected = nodes.reduce((sum, node) => sum + node.selected, 0)
  const span = `${first.title} … ${last.title}`
  return (
    <div className="grp-row grp-row--rollup">
      <button
        className="grp-disclosure"
        aria-label={`Expand ${nodes.length} similar suggestions`}
        aria-expanded={false}
        onClick={expand}
      >
        <IconChevron open={false} />
      </button>
      <GroupingCheck
        selected={selected}
        total={total}
        disabled={state.busy || Boolean(state.status.data?.accepting)}
        label={`Accept ${nodes.length} suggestions from ${span}`}
        change={(checked) =>
          state.edit({ action: 'select', nodes: nodes.map((node) => node.id), selected: checked })
        }
      />
      <span className="grp-kind">
        <IconLayers />
      </span>
      <span className="grp-row__content">
        <span className="grp-title">{span}</span>
        <span className="grp-hint">
          {nodes.length} bundles, same shape · each {groupingFileSummary(first)}
        </span>
      </span>
      <span className="portable-grp-actions">
        <button className="btn btn--compact" onClick={expand}>
          Show all {nodes.length}
        </button>
        {stem && <GroupingStemControls node={stem} state={state} />}
      </span>
    </div>
  )
}

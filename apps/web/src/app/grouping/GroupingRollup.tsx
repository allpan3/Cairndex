import type { GroupingNode } from '../../api/grouping'
import { IconChevron, IconLayers } from '../icons'
import { GroupingCheck } from './GroupingNodeRow'
import { GroupingStemControls } from './GroupingStemControls'
import { groupingFileSummary } from './groupingRows'
import { useGroupingStem } from './useGroupingStem'
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
  /** The member that speaks for the run's folder, which a folder of
   *  identically shaped clips is exactly the folder worth widening */
  stem?: GroupingNode
}) {
  const dial = useGroupingStem(stem, state, Boolean(stem))
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
        <button className="btn btn--compact grp-rollup__expand" onClick={expand}>
          Show all {nodes.length}
        </button>
      </span>
      {stem && (
        <span className="portable-grp-actions" data-no-row-drag="">
          <GroupingStemControls node={stem} state={state} stem={dial} />
        </span>
      )}
    </div>
  )
}

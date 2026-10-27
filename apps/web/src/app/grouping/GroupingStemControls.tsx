import type { GroupingNode } from '../../api/grouping'
import type { GroupingStemState } from './useGroupingStem'
import type { GroupingWorkspaceState } from './useGroupingWorkspace'

/** A folder's Narrow/Widen pair, on the row that speaks for that folder.
 *
 * Two fixed buttons and nothing else, as in the earlier review: labels that do
 * not change cannot shift under the pointer. A folder without a filename match
 * shows no buttons rather than a disabled pair on every row. */
export function GroupingStemControls({
  node,
  state,
  stem,
}: {
  node: GroupingNode
  state: GroupingWorkspaceState
  stem: GroupingStemState
}) {
  const { dial, error } = stem
  const blocked = state.busy || Boolean(state.status.data?.accepting)
  const folder = node.directory || 'the library root'
  if (error)
    return (
      <span className="grp-error" role="alert">
        Filename match unavailable{' '}
        <button
          className="btn btn--compact"
          aria-label={`Retry filename match for ${folder}`}
          title={error.message}
          onClick={stem.retry}
        >
          Retry
        </button>
      </span>
    )
  if (!dial) return null
  const matching = dial.stem ? `\nNow matching names like “${dial.stem}”.` : ''
  return (
    <span className="grp-dial" data-no-row-drag="">
      <button
        className="btn btn--compact"
        aria-label={`Narrow the filename match in ${folder}`}
        disabled={blocked || dial.level <= 0}
        title={
          dial.level <= 0
            ? `${folder} already matches complete filenames; there is nothing more to match`
            : `Match more of each filename in ${folder}, creating more, smaller bundles${matching}`
        }
        draggable={false}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={() => state.edit({ action: 'stem', node: node.id, level: dial.level - 1 })}
      >
        Narrow
      </button>
      <button
        className="btn btn--compact"
        aria-label={`Widen the filename match in ${folder}`}
        disabled={blocked || dial.level >= dial.max}
        title={
          dial.level >= dial.max
            ? `${folder} is already matched on the first part of each filename; there is nothing left to widen`
            : `Match a shorter part of each filename in ${folder}, creating fewer, larger bundles${matching}`
        }
        draggable={false}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={() => state.edit({ action: 'stem', node: node.id, level: dial.level + 1 })}
      >
        Widen
      </button>
    </span>
  )
}

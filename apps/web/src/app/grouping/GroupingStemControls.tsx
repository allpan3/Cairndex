import { useQuery } from '@tanstack/react-query'
import {
  grouping,
  type GroupingNode,
  type GroupingPage,
  type GroupingStem,
} from '../../api/grouping'
import type { GroupingWorkspaceState } from './useGroupingWorkspace'

export function GroupingStemControls({
  node,
  state,
}: {
  node: GroupingNode
  state: GroupingWorkspaceState
}) {
  const stems = useQuery({
    queryKey: [
      'grouping-stems',
      state.scope,
      state.library,
      state.workspace,
      state.status.data?.revision,
      node.directory,
    ],
    enabled: !node.context && state.status.data?.state === 'ready',
    queryFn: ({ signal }) =>
      grouping<GroupingPage<GroupingStem, string>>(
        state.library,
        `/workspaces/${state.workspace}/stems?${new URLSearchParams({ revision: String(state.status.data!.revision), directory: node.directory })}`,
        'GET',
        undefined,
        signal,
      ),
  })
  const dial = stems.data?.items[0]
  const blocked = state.busy || Boolean(state.status.data?.accepting)
  return (
    <>
      <span className="grp-dial">
        <button
          className="btn btn--compact"
          aria-label={`Narrow the filename match in ${node.directory || 'the library root'}`}
          disabled={blocked || !dial || dial.level <= 0}
          title="Match more of each filename, creating more bundles"
          onClick={() => state.edit({ action: 'stem', node: node.id, level: dial!.level - 1 })}
        >
          Narrow
        </button>
        <button
          className="btn btn--compact"
          aria-label={`Widen the filename match in ${node.directory || 'the library root'}`}
          disabled={blocked || !dial || dial.level >= dial.max}
          title="Match a shorter filename prefix, creating fewer bundles"
          onClick={() => state.edit({ action: 'stem', node: node.id, level: dial!.level + 1 })}
        >
          Widen
        </button>
      </span>
      {stems.error && (
        <span role="alert">
          {stems.error.message}
          <button onClick={() => void stems.refetch()}>Retry filename controls</button>
        </span>
      )}
    </>
  )
}

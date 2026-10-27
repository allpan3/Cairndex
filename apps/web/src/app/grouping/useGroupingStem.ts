import { keepPreviousData, useQuery } from '@tanstack/react-query'
import {
  grouping,
  type GroupingNode,
  type GroupingPage,
  type GroupingStem,
} from '../../api/grouping'
import type { GroupingWorkspaceState } from './useGroupingWorkspace'

/** The filename match of the folder `node` speaks for, when that folder has one.
 *
 * Only a folder with its own files has a match to adjust. `enabled` is false on
 * every row that does not speak for its folder, so those rows ask nothing. */
export function useGroupingStem(
  node: GroupingNode | undefined,
  state: GroupingWorkspaceState,
  enabled: boolean,
) {
  const stems = useQuery({
    queryKey: [
      'grouping-stems',
      state.scope,
      state.library,
      state.workspace,
      state.status.data?.revision,
      node?.directory,
    ],
    enabled: enabled && Boolean(node) && !node?.context && state.status.data?.state === 'ready',
    // The next revision's answer replaces this one in place, without a gap
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      grouping<GroupingPage<GroupingStem, string>>(
        state.library,
        `/workspaces/${state.workspace}/stems?${new URLSearchParams({ revision: String(state.status.data!.revision), directory: node!.directory })}`,
        'GET',
        undefined,
        signal,
      ),
  })
  const dial = stems.data?.items.find((item) => item.directory === node?.directory)
  return {
    dial: enabled ? dial : undefined,
    error: enabled ? stems.error : null,
    retry: () => void stems.refetch(),
  }
}

export type GroupingStemState = ReturnType<typeof useGroupingStem>

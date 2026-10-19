import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { grouping, type GroupingNode, type GroupingPage } from '../../api/grouping'
import { useModalDialog } from '../useModalDialog'
import type { GroupingWorkspaceState } from './useGroupingWorkspace'

export type GroupingMove = { node: GroupingNode; file?: string }

export function GroupingMoveDialog({
  state,
  move,
  onClose,
}: {
  state: GroupingWorkspaceState
  move: GroupingMove
  onClose: () => void
}) {
  const { ref, close } = useModalDialog(onClose)
  const [query, setQuery] = useState('')
  const [after, setAfter] = useState('')
  const revision = state.status.data!.revision
  const results = useQuery({
    queryKey: [
      'grouping-destinations',
      state.scope,
      state.library,
      state.workspace,
      revision,
      Boolean(move.file),
      query,
      after,
    ],
    queryFn: ({ signal }) =>
      grouping<GroupingPage<Pick<GroupingNode, 'id' | 'title' | 'directory'>, string>>(
        state.library,
        `/workspaces/${state.workspace}/destinations?${new URLSearchParams({
          revision: String(revision),
          kind: move.file ? 'bundle' : 'container',
          query,
          after,
        })}`,
        'GET',
        undefined,
        signal,
      ),
  })
  function choose(id: string | null) {
    if (move.file && id) state.edit({ action: 'move_file', file: move.file, node: id })
    else state.edit({ action: 'reparent', node: move.node.id, parent: id })
    close()
  }
  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div
        ref={ref}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Move grouping suggestion"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal__head">
          <h2>{move.file ? 'Move file to a bundle' : 'Move suggestion'}</h2>
          <button className="btn" onClick={close}>
            Cancel
          </button>
        </div>
        <input
          className="edit"
          aria-label="Search suggestion destinations"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setAfter('')
          }}
        />
        {!move.file && !query && (
          <button className="btn" onClick={() => choose(null)}>
            Top level
          </button>
        )}
        {results.isPending && <p role="status">Loading destinations…</p>}
        {results.error && (
          <p role="alert">
            {results.error.message}
            <button onClick={() => void results.refetch()}>Retry destinations</button>
          </p>
        )}
        <ul>
          {results.data?.items.map((item) => (
            <li key={item.id}>
              <button
                className="btn"
                disabled={
                  state.busy || Boolean(state.status.data?.accepting) || item.id === move.node.id
                }
                onClick={() => choose(item.id)}
              >
                {item.title}
                <small> · {item.directory || 'Library root'}</small>
              </button>
            </li>
          ))}
        </ul>
        {results.data?.items.length === 0 && <p>No matching suggestions.</p>}
        {results.data?.next_cursor && (
          <button onClick={() => setAfter(results.data!.next_cursor!)}>Next destinations</button>
        )}
        {after && <button onClick={() => setAfter('')}>First destinations</button>}
      </div>
    </div>
  )
}

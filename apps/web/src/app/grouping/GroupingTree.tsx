import { type KeyboardEvent, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { formatFileRole } from '../../lib/format'
import type { GroupingPlacementOption } from '../GroupingPlacementPicker'
import { IconChevron, IconFolder } from '../icons'
import { GroupingCheck, GroupingNodeRow } from './GroupingNodeRow'
import { GROUPING_DRAG, groupingDrag } from './groupingDrag'
import type { GroupingMove } from './GroupingMoveDialog'
import type { GroupingWorkspaceState } from './useGroupingWorkspace'
import type { GroupingTreeState, TreeRow } from './useGroupingTree'
import { GroupingRollup } from './GroupingRollup'

function checked(row: TreeRow): boolean | 'mixed' | undefined {
  if (row.kind === 'file') return row.file.selected
  let selected: number, total: number
  if (row.kind === 'node') ({ selected, files: total } = row.node)
  else if (row.kind === 'folder') ({ selected, files: total } = row.folder)
  else if (row.kind === 'rollup') {
    selected = row.nodes.reduce((sum, node) => sum + node.selected, 0)
    total = row.nodes.reduce((sum, node) => sum + node.files, 0)
  } else return undefined
  return selected === 0 ? false : selected === total ? true : 'mixed'
}

export function GroupingTree({
  state,
  tree,
  collections,
  onMove,
}: {
  state: GroupingWorkspaceState
  tree: GroupingTreeState
  collections: GroupingPlacementOption[]
  onMove: (move: GroupingMove) => void
}) {
  state = { ...state, busy: state.busy || tree.stale }
  const scroll = useRef<HTMLDivElement>(null)
  const [focus, setFocus] = useState(0)
  const blocked = state.busy || Boolean(state.status.data?.accepting)
  const rows = tree.rows
  // eslint-disable-next-line react-hooks/incompatible-library -- Used directly, without memoized consumers.
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 36,
    overscan: 8,
    getItemKey: (index) => rows[index]?.key ?? index,
  })
  const directoryRows = new Map<string, string>()
  for (const row of rows) {
    const nodes = row.kind === 'node' ? [row.node] : row.kind === 'rollup' ? row.nodes : []
    for (const node of nodes)
      if (!node.context && !directoryRows.has(node.directory))
        directoryRows.set(node.directory, node.id)
  }
  function focusRow(index: number) {
    index = Math.max(0, Math.min(rows.length - 1, index))
    setFocus(index)
    virtual.scrollToIndex(index)
    requestAnimationFrame(() =>
      scroll.current?.querySelector<HTMLElement>(`[data-row-index="${index}"]`)?.focus(),
    )
  }
  function key(event: KeyboardEvent<HTMLDivElement>, row: TreeRow, index: number) {
    const target = event.target as HTMLElement
    // Portal pickers keep their own navigation even though React bubbles their events here.
    if (!event.currentTarget.contains(target)) return
    if (target.closest('input:not([type="checkbox"]), textarea, select, [contenteditable="true"]'))
      return
    if (event.key === ' ' && event.target !== event.currentTarget) return
    const next =
      event.key === 'ArrowDown'
        ? index + 1
        : event.key === 'ArrowUp'
          ? index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? rows.length - 1
              : null
    if (next !== null) {
      event.preventDefault()
      focusRow(next)
      return
    }
    if (row.kind === 'rollup' && event.key === 'ArrowRight') {
      event.preventDefault()
      tree.toggleRun(row.run, true)
    }
    if (row.kind === 'folder' && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault()
      if (!blocked && row.folder.expanded !== (event.key === 'ArrowRight'))
        state.edit({
          action: 'folder',
          node: row.node.id,
          folder: row.folder.path,
          expanded: event.key === 'ArrowRight',
        })
    }
    if (row.kind === 'node' && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault()
      if (tree.expanded.has(row.node.id) !== (event.key === 'ArrowRight')) tree.toggle(row.node)
      else if (event.key === 'ArrowLeft') {
        const parent = rows.findIndex(
          (item) => item.kind === 'node' && item.node.id === row.node.parent,
        )
        if (parent >= 0) focusRow(parent)
      }
    }
    if (event.key !== ' ' || blocked) return
    event.preventDefault()
    if (row.kind === 'node')
      state.edit({
        action: 'select',
        node: row.node.id,
        selected: row.node.selected !== row.node.files,
      })
    else if (row.kind === 'file')
      state.edit({ action: 'select', file: row.file.id, selected: !row.file.selected })
    else if (row.kind === 'folder')
      state.edit({
        action: 'select',
        node: row.node.id,
        folder: row.folder.path,
        selected: row.folder.selected !== row.folder.files,
      })
    else if (row.kind === 'rollup')
      state.edit({
        action: 'select',
        nodes: row.nodes.map((node) => node.id),
        selected: row.nodes.some((node) => node.selected !== node.files),
      })
  }
  function render(row: TreeRow) {
    if (row.kind === 'rollup')
      return (
        <GroupingRollup
          nodes={row.nodes}
          state={state}
          expand={() => tree.toggleRun(row.run, true)}
          stem={row.nodes.find((node) => directoryRows.get(node.directory) === node.id)}
        />
      )
    if (row.kind === 'fold')
      return (
        <button className="btn btn--compact" onClick={() => tree.toggleRun(row.run, false)}>
          Fold {row.nodes.length} back into one row
        </button>
      )
    if (row.kind === 'loading') return <span role="status">Loading suggestions…</span>
    if (row.kind === 'error')
      return (
        <span role="alert">
          {row.message}
          <button onClick={row.retry}>Retry suggestion page</button>
        </span>
      )
    if (row.kind === 'more')
      return (
        <button className="btn" onClick={() => tree.loadMore(row.scope)}>
          Show more{' '}
          {row.scope.kind === 'nodes' || row.scope.kind === 'attention'
            ? 'suggestions'
            : row.scope.kind}
        </button>
      )
    if (row.kind === 'node')
      return (
        <GroupingNodeRow
          node={row.node}
          state={state}
          expanded={tree.expanded.has(row.node.id)}
          toggle={() => tree.toggle(row.node)}
          stem={directoryRows.get(row.node.directory) === row.node.id}
          collections={collections}
          onMove={onMove}
          onDragEnd={() => tree.setFileDragging(false)}
        />
      )
    if (row.kind === 'folder')
      return (
        <div className="grp-file grp-file--folder">
          <button
            className="grp-disclosure"
            aria-expanded={row.folder.expanded}
            disabled={blocked}
            aria-label={`${row.folder.expanded ? 'Hide' : 'Show'} files in ${row.folder.path}`}
            onClick={() =>
              state.edit({
                action: 'folder',
                node: row.node.id,
                folder: row.folder.path,
                expanded: !row.folder.expanded,
              })
            }
          >
            <IconChevron open={row.folder.expanded} />
          </button>
          <GroupingCheck
            selected={row.folder.selected}
            total={row.folder.files}
            disabled={blocked}
            label={`Accept folder ${row.folder.path}`}
            change={(selected) =>
              state.edit({ action: 'select', node: row.node.id, folder: row.folder.path, selected })
            }
          />
          <IconFolder />
          <span className="grp-file__name">{row.folder.path}</span>
          <span>{row.folder.files} files</span>
        </div>
      )
    const fileRows = rows.filter(
      (item): item is Extract<TreeRow, { kind: 'file' }> =>
        item.kind === 'file' && item.node.id === row.node.id,
    )
    const previous = fileRows.find((item) => item.file.sequence === row.file.sequence - 1)
    const next = fileRows.find((item) => item.file.sequence === row.file.sequence + 1)
    const afterNext = fileRows.find((item) => item.file.sequence === row.file.sequence + 2)
    return (
      <div
        className="grp-file grp-file--draggable"
        draggable={!blocked}
        data-grouping-file={row.file.id}
        onDragStart={(event) => {
          if ((event.target as HTMLElement).closest('button, input')) {
            event.preventDefault()
            return
          }
          event.stopPropagation()
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData(
            GROUPING_DRAG,
            JSON.stringify({ workspace: state.workspace, node: row.node.id, file: row.file.id }),
          )
          tree.setFileDragging(true)
        }}
        onDragEnd={() => tree.setFileDragging(false)}
        onDragOver={(event) => {
          if (!blocked && event.dataTransfer.types.includes(GROUPING_DRAG)) event.preventDefault()
        }}
        onDrop={(event) => {
          const dragged = groupingDrag(event, state.workspace)
          if (!blocked && dragged?.file && dragged.file !== row.file.id) {
            event.preventDefault()
            event.stopPropagation()
            state.edit({
              action: 'move_file',
              file: dragged.file,
              node: row.node.id,
              before: row.file.id,
            })
          }
        }}
      >
        <GroupingCheck
          selected={Number(row.file.selected)}
          total={1}
          disabled={blocked}
          label={`Accept file ${row.file.path}`}
          change={(selected) => state.edit({ action: 'select', file: row.file.id, selected })}
        />
        <span className="grp-file__name" title={row.file.path}>
          {row.file.path.split('/').at(-1)}
        </span>
        <span className="grp-file__role">{formatFileRole(row.file.media_kind, row.file.path)}</span>
        <span className="portable-grp-actions">
          <button
            className="btn btn--compact"
            aria-label={`Move ${row.file.path} up`}
            disabled={blocked || !previous}
            onClick={() =>
              state.edit({
                action: 'move_file',
                file: row.file.id,
                node: row.node.id,
                before: previous!.file.id,
              })
            }
          >
            ↑
          </button>
          <button
            className="btn btn--compact"
            aria-label={`Move ${row.file.path} down`}
            disabled={blocked || !next || (!afterNext && row.file.sequence + 2 < row.node.files)}
            onClick={() =>
              state.edit({
                action: 'move_file',
                file: row.file.id,
                node: row.node.id,
                before: afterNext?.file.id ?? null,
              })
            }
          >
            ↓
          </button>
          <button
            className="btn btn--compact"
            aria-label={`Move file ${row.file.path} to another suggestion`}
            disabled={blocked}
            onClick={() => onMove({ node: row.node, file: row.file.id })}
          >
            Move…
          </button>
        </span>
      </div>
    )
  }
  return (
    <div
      ref={scroll}
      className="portable-grp-tree"
      role="tree"
      aria-label="Grouping suggestions"
      onDrop={() => tree.setFileDragging(false)}
      onDragEnd={() => tree.setFileDragging(false)}
      style={{ height: `min(54vh, ${Math.max(120, virtual.getTotalSize())}px)` }}
    >
      {rows.length === 0 && (
        <p className="grp-empty" role="status">
          No grouping suggestions in this view.
        </p>
      )}
      <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
        {virtual.getVirtualItems().map((item) => {
          const row = rows[item.index]
          if (!row) return null
          return (
            <div
              key={row.key}
              ref={virtual.measureElement}
              data-index={item.index}
              data-row-index={item.index}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-expanded={
                row.kind === 'node'
                  ? tree.expanded.has(row.node.id)
                  : row.kind === 'rollup'
                    ? false
                    : row.kind === 'folder'
                      ? row.folder.expanded
                      : undefined
              }
              aria-checked={checked(row)}
              tabIndex={item.index === Math.min(focus, rows.length - 1) ? 0 : -1}
              onFocus={() => setFocus(item.index)}
              onKeyDown={(event) => key(event, row, item.index)}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${item.start}px)`,
                paddingLeft: row.depth * 22,
                boxSizing: 'border-box',
              }}
            >
              {render(row)}
            </div>
          )
        })}
      </div>
    </div>
  )
}

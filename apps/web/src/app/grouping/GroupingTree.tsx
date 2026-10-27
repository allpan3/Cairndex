import { type KeyboardEvent, type MouseEvent, useLayoutEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { GroupingNode } from '../../api/grouping'
import { formatFileRole } from '../../lib/format'
import { ContextMenu } from '../ContextMenu'
import type { GroupingPlacementOption } from '../GroupingPlacementPicker'
import { IconChevron, IconFolder } from '../icons'
import { useContextMenu, type MenuEntry } from '../useContextMenu'
import { GroupingCheck, GroupingNodeRow } from './GroupingNodeRow'
import { convertible } from './groupingRows'
import { GROUPING_DRAG, groupingDrag } from './groupingDrag'
import type { GroupingMove } from './GroupingMoveDialog'
import type { GroupingWorkspaceState } from './useGroupingWorkspace'
import type { GroupingTreeState, TreeRow } from './useGroupingTree'
import { GroupingRollup } from './GroupingRollup'

/** One selection command holds at most this many suggestions */
const SELECT_LIMIT = 50

type SectionRow = Extract<TreeRow, { kind: 'section' }>
type FileRow = Extract<TreeRow, { kind: 'file' }>

/** A section can be selected as one only when all of it is loaded and fits one command */
function sectionSelectable(row: SectionRow) {
  return (
    row.section === 'additions' &&
    row.complete &&
    row.nodes.length > 0 &&
    row.nodes.length <= SELECT_LIMIT
  )
}

function checked(row: TreeRow): boolean | 'mixed' | undefined {
  if (row.kind === 'file') return row.file.selected
  let selected: number, total: number
  if (row.kind === 'node') ({ selected, files: total } = row.node)
  else if (row.kind === 'folder') ({ selected, files: total } = row.folder)
  else if (row.kind === 'rollup' || (row.kind === 'section' && sectionSelectable(row))) {
    selected = row.nodes.reduce((sum, node) => sum + node.selected, 0)
    total = row.nodes.reduce((sum, node) => sum + node.files, 0)
  } else return undefined
  return selected === 0 ? false : selected === total ? true : 'mixed'
}

const SECTION_TITLES = {
  additions: 'Add to existing bundles',
  suggestions: 'New bundles and collections',
} as const

export function GroupingTree({
  state,
  tree,
  collections,
  collectionsLoading = false,
  collectionsError = false,
  onMove,
}: {
  state: GroupingWorkspaceState
  tree: GroupingTreeState
  collections: GroupingPlacementOption[]
  collectionsLoading?: boolean
  collectionsError?: boolean
  onMove: (move: GroupingMove) => void
}) {
  state = { ...state, busy: state.busy || tree.stale }
  const scroll = useRef<HTMLDivElement>(null)
  const pendingFocus = useRef<{ key: string; origin: Element | null } | null>(null)
  const [focus, setFocus] = useState(0)
  const menu = useContextMenu()
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
  useLayoutEffect(() => {
    const pending = pendingFocus.current
    if (!pending) return
    const index = rows.findIndex((row) => row.key === pending.key)
    if (
      index < 0 ||
      (document.activeElement !== pending.origin && document.activeElement !== document.body)
    ) {
      pendingFocus.current = null
      return
    }
    const target = scroll.current?.querySelector<HTMLElement>(`[data-row-index="${index}"]`)
    if (target) {
      pendingFocus.current = null
      target.focus()
    }
  })
  // The shared menu takes no focus, and this modal keeps Tab inside itself, so
  // the menu's first item takes focus, arrows move between items, and Tab
  // closes it.
  useLayoutEffect(() => {
    if (menu.state)
      document
        .querySelector<HTMLElement>('.context-menu [role="menuitem"]:not(:disabled)')
        ?.focus({ preventScroll: true })
  }, [menu.state])
  function menuKey(event: KeyboardEvent<HTMLDivElement>) {
    const list = (event.target as HTMLElement).closest('.context-menu')
    if (!list) return
    if (event.key === 'Tab') {
      event.preventDefault()
      menu.state?.returnFocus?.focus({ preventScroll: true })
      menu.close()
      return
    }
    const items = Array.from(list.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)'))
    const at = items.indexOf(event.target as HTMLElement)
    const moves: Record<string, number> = {
      ArrowDown: at + 1,
      ArrowUp: at - 1,
      Home: 0,
      End: items.length - 1,
    }
    const next = moves[event.key]
    if (next === undefined || items.length === 0) return
    event.preventDefault()
    items.at(next % items.length)?.focus({ preventScroll: true })
  }
  // The row that speaks for a folder carries its Narrow/Widen. Rows in the
  // separated tree claim their folders first: an addition's pair would regroup
  // suggestions drawn in the other section.
  const directoryRows = new Map<string, string>()
  const rowNodes = (row: TreeRow) =>
    row.kind === 'node' ? [row.node] : row.kind === 'rollup' ? row.nodes : []
  for (const pass of tree.sectioned ? [false, true] : [null])
    for (const row of rows)
      for (const node of rowNodes(row))
        if (
          !node.context &&
          (pass === null || Boolean(node.target) === pass) &&
          !directoryRows.has(node.directory)
        )
          directoryRows.set(node.directory, node.id)
  const additionIds = new Set<string>()
  let inAdditions = false
  for (const row of rows) {
    if (row.kind === 'section') inAdditions = row.section === 'additions'
    else if (inAdditions && row.kind === 'node') additionIds.add(row.node.id)
  }
  function focusRow(index: number) {
    index = Math.max(0, Math.min(rows.length - 1, index))
    const row = rows[index]
    if (!row) return
    // A virtual row may mount on a later render, after scrolling has settled.
    pendingFocus.current = { key: row.key, origin: document.activeElement }
    setFocus(index)
    virtual.scrollToIndex(index)
  }
  function selectNode(node: GroupingNode, selected: boolean) {
    state.edit({
      action: 'select',
      node: node.id,
      selected,
      ...(tree.separate && node.kind === 'container' ? { exclude_additions: true } : {}),
    })
  }
  function fileMoves(row: FileRow) {
    const fileRows = rows.filter(
      (item): item is FileRow => item.kind === 'file' && item.node.id === row.node.id,
    )
    const previous = fileRows.find((item) => item.file.sequence === row.file.sequence - 1)
    const next = fileRows.find((item) => item.file.sequence === row.file.sequence + 1)
    const afterNext = fileRows.find((item) => item.file.sequence === row.file.sequence + 2)
    return {
      up: previous
        ? () =>
            state.edit({
              action: 'move_file',
              file: row.file.id,
              node: row.node.id,
              before: previous.file.id,
            })
        : null,
      down:
        next && (afterNext || row.file.sequence + 2 >= row.node.files)
          ? () =>
              state.edit({
                action: 'move_file',
                file: row.file.id,
                node: row.node.id,
                before: afterNext?.file.id ?? null,
              })
          : null,
    }
  }
  // Secondary actions live in one menu, opened by right-click, Shift+F10 or
  // the Menu key, so rows carry no button cluster for them
  function openMenu(event: MouseEvent<HTMLDivElement>, row: TreeRow) {
    const target = event.target as HTMLElement
    // Pickers rendered in portals, and the rename field, keep their own menus
    if (!event.currentTarget.contains(target) || target.closest('input:not([type="checkbox"])'))
      return
    let items: MenuEntry[] = []
    if (row.kind === 'node' && !row.node.context) {
      const node = row.node
      const title = event.currentTarget.querySelector<HTMLButtonElement>('.grp-title--editable')
      items = [
        { label: 'Rename', disabled: blocked || !title, onClick: () => title?.click() },
        ...(convertible(node)
          ? [
              {
                label: node.kind === 'bundle' ? 'Convert to collection' : 'Convert to bundle',
                disabled: blocked,
                onClick: () =>
                  state.edit({
                    action: 'kind',
                    node: node.id,
                    kind: node.kind === 'bundle' ? 'container' : 'bundle',
                  }),
              },
            ]
          : []),
        ...(!node.target
          ? [{ label: 'Move to…', disabled: blocked, onClick: () => onMove({ node }) }]
          : []),
        ...(node.original_target
          ? [
              {
                label: node.target ? 'New bundle instead' : 'Add to existing bundle instead',
                disabled: blocked || node.files === 0,
                onClick: () =>
                  state.edit({
                    action: 'destination',
                    node: node.id,
                    create_new: Boolean(node.target),
                  }),
              },
            ]
          : []),
      ]
    } else if (row.kind === 'file') {
      const moves = fileMoves(row)
      items = [
        { label: 'Move up', disabled: blocked || !moves.up, onClick: () => moves.up?.() },
        { label: 'Move down', disabled: blocked || !moves.down, onClick: () => moves.down?.() },
        {
          label: 'Move to another bundle…',
          disabled: blocked,
          onClick: () => onMove({ node: row.node, file: row.file.id }),
        },
      ]
    }
    if (items.length === 0) return
    // A keyboard-opened menu reports 0, 0; place it under the row instead
    const rect = event.currentTarget.getBoundingClientRect()
    const keyboard = event.clientX === 0 && event.clientY === 0
    menu.open(event, items, keyboard ? { x: rect.left + 24, y: rect.bottom } : undefined)
  }
  function key(event: KeyboardEvent<HTMLDivElement>, row: TreeRow, index: number) {
    const target = event.target as HTMLElement
    // Portal pickers keep their own navigation even though React bubbles their events here.
    if (!event.currentTarget.contains(target)) return
    if (target.closest('input:not([type="checkbox"]), textarea, select, [contenteditable="true"]'))
      return
    // Shift+F10 and the Menu key open the row's menu on every platform, macOS
    // included, which has no key of its own for it
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault()
      event.currentTarget.dispatchEvent(
        new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      )
      return
    }
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
    // Left from a top-level row goes to the heading of its section
    const heading = () => {
      for (let i = index - 1; i >= 0; i--) if (rows[i]?.kind === 'section') return focusRow(i)
    }
    if (row.kind === 'section' && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault()
      if (row.open !== (event.key === 'ArrowRight'))
        tree.toggleSection(row.section, event.key === 'ArrowRight')
    }
    if (row.kind === 'rollup' && event.key === 'ArrowRight') {
      event.preventDefault()
      tree.toggleRun(row.run, true)
    }
    if (row.kind === 'rollup' && event.key === 'ArrowLeft' && tree.sectioned && row.depth === 0) {
      event.preventDefault()
      heading()
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
        else if (tree.sectioned && row.depth === 0) heading()
      }
    }
    // F2 renames from anywhere in the row. Enter renames only from the row
    // itself, so the row's buttons keep their own Enter.
    if (
      row.kind === 'node' &&
      (event.key === 'F2' || (event.key === 'Enter' && event.target === event.currentTarget))
    ) {
      const title = event.currentTarget.querySelector<HTMLButtonElement>('.grp-title--editable')
      if (title && !title.disabled && !(event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        title.click()
      }
      return
    }
    if (event.key !== ' ' || blocked) return
    event.preventDefault()
    if (row.kind === 'node') selectNode(row.node, row.node.selected !== row.node.files)
    else if (row.kind === 'file')
      state.edit({ action: 'select', file: row.file.id, selected: !row.file.selected })
    else if (row.kind === 'folder')
      state.edit({
        action: 'select',
        node: row.node.id,
        folder: row.folder.path,
        selected: row.folder.selected !== row.folder.files,
      })
    else if (row.kind === 'rollup' || (row.kind === 'section' && sectionSelectable(row)))
      state.edit({
        action: 'select',
        nodes: row.nodes.map((node) => node.id),
        selected: row.nodes.some((node) => node.selected !== node.files),
      })
  }
  function render(row: TreeRow) {
    if (row.kind === 'section') {
      const selectable = sectionSelectable(row)
      return (
        <div className="grp-section">
          <button
            className="grp-disclosure"
            aria-label={`${row.open ? 'Collapse' : 'Expand'} ${SECTION_TITLES[row.section]}`}
            aria-expanded={row.open}
            onClick={() => tree.toggleSection(row.section, !row.open)}
          >
            <IconChevron open={row.open} />
          </button>
          {selectable && (
            <GroupingCheck
              selected={row.nodes.reduce((sum, node) => sum + node.selected, 0)}
              total={row.nodes.reduce((sum, node) => sum + node.files, 0)}
              disabled={blocked}
              label={
                row.nodes.length === 1
                  ? 'Accept the addition'
                  : `Accept all ${row.nodes.length} additions`
              }
              change={(selected) =>
                state.edit({ action: 'select', nodes: row.nodes.map((node) => node.id), selected })
              }
            />
          )}
          <span
            className="grp-section__title"
            title={
              row.section === 'additions'
                ? 'New files that join bundles already in your library. Those bundles keep their place.'
                : 'New bundles, and collections to hold them'
            }
          >
            {SECTION_TITLES[row.section]}
          </span>
          {row.complete && <span className="grp-hint">{row.nodes.length}</span>}
        </div>
      )
    }
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
        <span className="grp-error" role="alert">
          {row.message}{' '}
          <button className="btn btn--compact" onClick={row.retry}>
            Retry suggestion page
          </button>
        </span>
      )
    if (row.kind === 'more')
      return (
        <button className="btn btn--compact" onClick={() => tree.loadMore(row.scope)}>
          Show more{' '}
          {row.scope.kind === 'additions' || row.scope.kind === 'uncertain_additions'
            ? 'additions'
            : row.scope.kind === 'nodes' || row.scope.kind === 'attention'
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
          separate={tree.separate}
          inAdditions={additionIds.has(row.node.id)}
          collections={collections}
          collectionsLoading={collectionsLoading}
          collectionsError={collectionsError}
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
    const moves = fileMoves(row)
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
        {/* Shown with the row's hover or focus; the menu and drag do the same */}
        <span className="portable-grp-actions portable-grp-actions--quiet">
          <button
            className="btn btn--compact"
            aria-label={`Move ${row.file.path} up`}
            title="Move up"
            disabled={blocked || !moves.up}
            onClick={() => moves.up?.()}
          >
            ↑
          </button>
          <button
            className="btn btn--compact"
            aria-label={`Move ${row.file.path} down`}
            title="Move down"
            disabled={blocked || !moves.down}
            onClick={() => moves.down?.()}
          >
            ↓
          </button>
          <button
            className="btn btn--compact"
            aria-label={`Move file ${row.file.path} to another suggestion`}
            title="Move to another bundle"
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
      // The menu renders in a portal but its key events arrive here
      onKeyDown={menuKey}
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
              // Rows sit one level inside their section heading
              aria-level={row.kind === 'section' ? 1 : row.depth + (tree.sectioned ? 2 : 1)}
              aria-expanded={
                row.kind === 'node'
                  ? tree.expanded.has(row.node.id)
                  : row.kind === 'rollup'
                    ? false
                    : row.kind === 'folder'
                      ? row.folder.expanded
                      : row.kind === 'section'
                        ? row.open
                        : undefined
              }
              aria-checked={checked(row)}
              tabIndex={item.index === Math.min(focus, rows.length - 1) ? 0 : -1}
              onFocus={() => setFocus(item.index)}
              onKeyDown={(event) => key(event, row, item.index)}
              onContextMenu={(event) => openMenu(event, row)}
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
      {menu.state && <ContextMenu state={menu.state} onClose={menu.close} />}
    </div>
  )
}

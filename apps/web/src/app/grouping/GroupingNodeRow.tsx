import { type DragEvent, useLayoutEffect, useRef, useState } from 'react'
import type { GroupingNode } from '../../api/grouping'
import { GroupingPlacementPicker, type GroupingPlacementOption } from '../GroupingPlacementPicker'
import { IconChevron, IconFolder, IconLayers } from '../icons'
import { ContextMenu } from '../ContextMenu'
import { useContextMenu } from '../useContextMenu'
import type { GroupingWorkspaceState } from './useGroupingWorkspace'
import type { GroupingMove } from './GroupingMoveDialog'
import { GROUPING_DRAG, groupingDrag } from './groupingDrag'
import { GroupingStemControls } from './GroupingStemControls'
import { groupingFileSummary } from './groupingRows'

export function GroupingCheck({
  selected,
  total,
  disabled,
  label,
  change,
}: {
  selected: number
  total: number
  disabled: boolean
  label: string
  change: (selected: boolean) => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  useLayoutEffect(() => {
    if (!ref.current || disabled) return
    ref.current.checked = total > 0 && selected === total
    ref.current.indeterminate = selected > 0 && selected < total
  }, [selected, total, disabled])
  return (
    <input
      className="grp-check"
      type="checkbox"
      aria-label={label}
      ref={ref}
      // Keep the click visible until the worker acknowledges or refuses it.
      // Reconcile with durable selection as soon as editing is enabled again.
      defaultChecked={total > 0 && selected === total}
      disabled={disabled || total === 0}
      onChange={(event) => change(event.target.checked)}
    />
  )
}

function caretOffset(event: React.MouseEvent): number | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offset: number } | null
    caretRangeFromPoint?: (x: number, y: number) => Range | null
  }
  return (
    doc.caretPositionFromPoint?.(event.clientX, event.clientY)?.offset ??
    doc.caretRangeFromPoint?.(event.clientX, event.clientY)?.startOffset ??
    null
  )
}

export function GroupingNodeRow({
  node,
  state,
  expanded,
  toggle,
  stem,
  collections,
  onMove,
  onDragEnd,
}: {
  node: GroupingNode
  state: GroupingWorkspaceState
  expanded: boolean
  toggle: () => void
  stem: boolean
  collections: GroupingPlacementOption[]
  onMove: (move: GroupingMove) => void
  onDragEnd: () => void
}) {
  const blocked = state.busy || Boolean(state.status.data?.accepting)
  const [renaming, setRenaming] = useState(false)
  const [title, setTitle] = useState(node.title)
  const caret = useRef<number | null>(null)
  const renameDone = useRef(false)
  const menu = useContextMenu()
  const editable = !blocked && !node.context && !node.target
  const displayed = node.target ? (node.target_title ?? node.title) : node.title
  function rename(offset: number | null = null) {
    if (!editable) return
    setTitle(node.title)
    caret.current = offset
    renameDone.current = false
    setRenaming(true)
  }
  function commit() {
    if (renameDone.current) return
    renameDone.current = true
    setRenaming(false)
    if (title.trim() && title !== node.title) state.edit({ action: 'rename', node: node.id, title })
  }
  function drop(event: DragEvent) {
    const dragged = groupingDrag(event, state.workspace)
    if (!dragged || blocked) return
    event.preventDefault()
    event.stopPropagation()
    onDragEnd()
    if (dragged.file && node.kind === 'bundle')
      state.edit({ action: 'move_file', node: node.id, file: dragged.file })
    else if (!dragged.file && dragged.node !== node.id) {
      const rect = event.currentTarget.getBoundingClientRect()
      const before = node.kind === 'bundle' || event.clientY < rect.top + rect.height / 3
      state.edit(
        before
          ? { action: 'reparent', node: dragged.node, parent: node.parent, before: node.id }
          : { action: 'reparent', node: dragged.node, parent: node.id },
      )
    }
  }
  return (
    <div className={`grp-node grp-node--${node.kind}`}>
      <div
        className={`grp-row ${node.kind === 'bundle' ? 'grp-row--bundle' : 'grp-row--collection grp-row--folder'}${node.confidence < 0.75 && !node.context ? ' grp-row--attention' : ''}`}
        data-grouping-node={node.id}
        draggable={!blocked && !node.context && !renaming}
        onDragStart={(event) => {
          if ((event.target as HTMLElement).closest('button, input, [data-no-row-drag]')) {
            event.preventDefault()
            return
          }
          event.dataTransfer.setData(
            GROUPING_DRAG,
            JSON.stringify({ workspace: state.workspace, node: node.id }),
          )
          event.dataTransfer.effectAllowed = 'move'
        }}
        onDragEnd={onDragEnd}
        onDragOver={(event) => {
          if (!blocked && event.dataTransfer.types.includes(GROUPING_DRAG)) event.preventDefault()
        }}
        onDrop={drop}
      >
        <button
          className="grp-disclosure"
          aria-label={`${expanded ? 'Collapse' : 'Expand'} suggestion ${displayed}`}
          aria-expanded={expanded}
          onClick={toggle}
        >
          <IconChevron open={expanded} />
        </button>
        <GroupingCheck
          selected={node.selected}
          total={node.files}
          disabled={blocked}
          label={`Accept ${displayed}`}
          change={(selected) => state.edit({ action: 'select', node: node.id, selected })}
        />
        <span className="grp-kind">
          {node.kind === 'container' ? <IconFolder /> : <IconLayers />}
        </span>
        <div className="grp-row__content">
          {renaming ? (
            <span className="grp-title grp-title-editor" data-value={title || ' '}>
              <input
                className="grp-title-input"
                aria-label={`Rename suggestion ${displayed}`}
                value={title}
                ref={(element) => {
                  if (element && document.activeElement !== element) {
                    element.focus()
                    const p = caret.current ?? title.length
                    element.setSelectionRange(p, p)
                  }
                }}
                onChange={(event) => setTitle(event.target.value)}
                onBlur={commit}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    event.stopPropagation()
                    commit()
                  } else if (event.key === 'Escape') {
                    event.preventDefault()
                    event.stopPropagation()
                    renameDone.current = true
                    setRenaming(false)
                  }
                }}
              />
            </span>
          ) : (
            <button
              className={`grp-title${editable ? ' grp-title--editable' : ''}`}
              disabled={!editable}
              onDoubleClick={(event) => rename(caretOffset(event))}
              onClick={(event) => {
                if (event.detail === 0) rename()
              }}
              title={node.reason}
            >
              {displayed}
            </button>
          )}
          <span className="grp-hint">
            {node.context
              ? 'Existing collection'
              : node.kind === 'container'
                ? `${node.bundles} ${node.bundles === 1 ? 'bundle' : 'bundles'}`
                : groupingFileSummary(node)}
            {node.target ? ' · Add to existing bundle' : ''}
            {node.confidence < 0.75 && !node.context ? ' · Needs a look' : ''}
          </span>
        </div>
        {!node.context && (
          <span className="portable-grp-actions" data-no-row-drag="">
            {stem && <GroupingStemControls node={node} state={state} />}
            {!node.target && (
              <GroupingPlacementPicker
                compact
                kind={node.kind === 'bundle' ? 'bundle' : 'collection'}
                title={displayed}
                currentId={node.collection ?? (node.parent ? undefined : null)}
                options={collections}
                disabled={blocked}
                onChange={(collection) =>
                  state.edit(
                    collection
                      ? { action: 'reparent', node: node.id, collection }
                      : { action: 'reparent', node: node.id, parent: null },
                  )
                }
              />
            )}
            <button
              className="btn btn--compact"
              aria-label={`Actions for suggestion ${displayed}`}
              disabled={blocked}
              aria-haspopup="menu"
              onClick={(event) => {
                const r = event.currentTarget.getBoundingClientRect()
                menu.open(
                  event,
                  [
                    { label: 'Rename', disabled: !editable, onClick: () => rename() },
                    {
                      label: `Make ${node.kind === 'bundle' ? 'collection' : 'bundle'}`,
                      disabled: Boolean(node.target),
                      onClick: () =>
                        state.edit({
                          action: 'kind',
                          node: node.id,
                          kind: node.kind === 'bundle' ? 'container' : 'bundle',
                        }),
                    },
                    {
                      label: 'Move to suggestion…',
                      disabled: Boolean(node.target),
                      onClick: () => onMove({ node }),
                    },
                    ...(node.original_target
                      ? [
                          {
                            label: node.target
                              ? 'Make a new bundle instead'
                              : 'Add to existing bundle instead',
                            onClick: () =>
                              state.edit({
                                action: 'destination',
                                node: node.id,
                                create_new: Boolean(node.target),
                              }),
                          },
                        ]
                      : []),
                  ],
                  { x: r.left, y: r.bottom },
                )
              }}
            >
              …
            </button>
          </span>
        )}
      </div>
      {menu.state && <ContextMenu state={menu.state} onClose={menu.close} />}
    </div>
  )
}

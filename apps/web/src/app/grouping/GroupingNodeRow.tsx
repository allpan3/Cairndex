import { type DragEvent, useLayoutEffect, useRef, useState } from 'react'
import type { GroupingNode } from '../../api/grouping'
import { GroupingPlacementPicker, type GroupingPlacementOption } from '../GroupingPlacementPicker'
import { IconChevron, IconFolder, IconLayers } from '../icons'
import type { GroupingWorkspaceState } from './useGroupingWorkspace'
import { GROUPING_DRAG, groupingDrag } from './groupingDrag'
import { GroupingStemControls } from './GroupingStemControls'
import { convertible, groupingFileSummary, groupingTitle, needsLook } from './groupingRows'
import { useGroupingStem } from './useGroupingStem'

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
  separate,
  inAdditions,
  collections,
  collectionsLoading,
  collectionsError,
  onDragEnd,
}: {
  node: GroupingNode
  state: GroupingWorkspaceState
  expanded: boolean
  toggle: () => void
  /** This row speaks for its folder and carries the folder's Narrow/Widen */
  stem: boolean
  /** The server lists additions separately (grouping_version 2) */
  separate: boolean
  inAdditions: boolean
  collections: GroupingPlacementOption[]
  collectionsLoading: boolean
  collectionsError: boolean
  onDragEnd: () => void
}) {
  const blocked = state.busy || Boolean(state.status.data?.accepting)
  const [renaming, setRenaming] = useState(false)
  const [title, setTitle] = useState(node.title)
  const caret = useRef<number | null>(null)
  const renameDone = useRef(false)
  const dial = useGroupingStem(node, state, stem)
  const editable = !blocked && !node.context && !node.target
  const displayed = groupingTitle(node, inAdditions)
  const attention = needsLook(node)
  const folder = node.directory || 'the library root'
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
    // An addition joins a bundle that already has its place
    else if (!dragged.file && dragged.node !== node.id && !node.target) {
      const rect = event.currentTarget.getBoundingClientRect()
      const before = node.kind === 'bundle' || event.clientY < rect.top + rect.height / 3
      state.edit(
        before
          ? { action: 'reparent', node: dragged.node, parent: node.parent, before: node.id }
          : { action: 'reparent', node: dragged.node, parent: node.id },
      )
    }
  }
  const kindIcon = node.kind === 'container' ? <IconFolder /> : <IconLayers />
  const convertLabel = node.kind === 'bundle' ? 'Convert to collection' : 'Convert to bundle'
  return (
    <div className={`grp-node grp-node--${node.kind}`}>
      <div
        className={`grp-row ${node.kind === 'bundle' ? 'grp-row--bundle' : 'grp-row--collection'}${
          node.kind === 'container' && dial.dial ? ' grp-row--folder' : ''
        }${attention ? ' grp-row--attention' : ''}`}
        data-grouping-node={node.id}
        // An addition has no placement of its own, so it is not dragged
        draggable={!blocked && !node.context && !node.target && !renaming}
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
          change={(selected) =>
            state.edit({
              action: 'select',
              node: node.id,
              selected,
              // The additions above keep their own checkboxes
              ...(separate && node.kind === 'container' ? { exclude_additions: true } : {}),
            })
          }
        />
        {/* The kind glyph is the convert control, in the place the kind is shown */}
        {convertible(node) ? (
          <button
            className="grp-kind grp-kind--convert"
            disabled={blocked}
            title={convertLabel}
            aria-label={`${convertLabel}: ${displayed}`}
            draggable={false}
            data-no-row-drag=""
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() =>
              state.edit({
                action: 'kind',
                node: node.id,
                kind: node.kind === 'bundle' ? 'container' : 'bundle',
              })
            }
          >
            {kindIcon}
          </button>
        ) : (
          <span className="grp-kind">{kindIcon}</span>
        )}
        <div className="grp-row__content">
          <span className="grp-title-cluster">
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
                    if (event.key !== 'Enter' && event.key !== 'Escape') return
                    event.preventDefault()
                    event.stopPropagation()
                    // Keyboard renames return to their row rather than to the page
                    const item = event.currentTarget.closest<HTMLElement>('[role="treeitem"]')
                    if (event.key === 'Enter') commit()
                    else {
                      renameDone.current = true
                      setRenaming(false)
                    }
                    item?.focus()
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
                // Where the files come from; the tree says where they go
                title={[
                  `From ${folder}`,
                  attention ? '' : node.reason,
                  editable ? 'Double-click or press F2 to rename' : '',
                ]
                  .filter(Boolean)
                  .join('\n')}
              >
                {displayed}
              </button>
            )}
            {node.original_target && (
              <button
                className="btn btn--compact grp-dest"
                disabled={blocked || node.files === 0}
                title={
                  node.target
                    ? 'Create a new bundle from these files'
                    : `Add these files to “${node.target_title ?? 'the existing bundle'}” instead`
                }
                aria-label={
                  node.target
                    ? `New bundle instead of adding to ${node.target_title ?? node.title}`
                    : `Add to bundle ${node.target_title ?? node.title} instead`
                }
                draggable={false}
                data-no-row-drag=""
                onMouseDown={(event) => event.stopPropagation()}
                onClick={() =>
                  state.edit({
                    action: 'destination',
                    node: node.id,
                    create_new: Boolean(node.target),
                  })
                }
              >
                {node.target ? 'New bundle' : 'Add to bundle'}
              </button>
            )}
          </span>
          {node.context && (
            <span className="grp-existing" title="A collection already in your library">
              Existing
            </span>
          )}
          <span className="grp-hint">
            {node.kind === 'container'
              ? `${node.bundles} ${node.bundles === 1 ? 'bundle' : 'bundles'}`
              : node.target
                ? `${node.files} new ${node.files === 1 ? 'file' : 'files'}`
                : groupingFileSummary(node)}
          </span>
          {attention && node.reason && <span className="grp-attention">{node.reason}</span>}
        </div>
        {!node.context && (
          <span className="portable-grp-actions" data-no-row-drag="">
            {/* An addition joins a bundle that already has its place */}
            {!node.target && (
              <GroupingPlacementPicker
                // A nested row's place is the row it is drawn inside
                compact={Boolean(node.parent)}
                restated={Boolean(node.parent)}
                kind={node.kind === 'bundle' ? 'bundle' : 'collection'}
                title={displayed}
                currentId={node.collection ?? (node.parent ? undefined : null)}
                options={collections}
                loading={collectionsLoading}
                error={collectionsError}
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
            {stem && <GroupingStemControls node={node} state={state} stem={dial} />}
          </span>
        )}
      </div>
    </div>
  )
}

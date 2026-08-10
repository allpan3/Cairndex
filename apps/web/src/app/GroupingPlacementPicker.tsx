import { type KeyboardEvent, useState } from 'react'
import { createPortal } from 'react-dom'

import { IconChevron, IconFolder } from './icons'
import { PickGuides } from './PickGuides'
import { usePinyinSearch } from './pinyin'
import { usePopover, visibleHierarchy } from './usePopover'

/** One persisted collection destination in the library's current hierarchy */
export interface GroupingPlacementOption {
  id: string
  parent_id: string | null
  name: string
  path: string
}

/** Move focus among the visible destination choices with listbox keys */
function moveOptionFocus(event: KeyboardEvent<HTMLButtonElement>) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  const panel = event.currentTarget.closest('.grp-placement-panel')
  const options = [...(panel?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])]
  if (options.length === 0) return
  const current = Math.max(0, options.indexOf(event.currentTarget))
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? options.length - 1
        : Math.max(0, Math.min(options.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))
  event.preventDefault()
  options[next]?.focus()
}

/** Render one single-select destination row plus its independent branch toggle */
function PlacementOptionRow({
  option,
  depth,
  hasChildren,
  selected,
  collapsed,
  flat,
  parentName,
  onSelect,
  onToggle,
}: {
  option: GroupingPlacementOption
  depth: number
  hasChildren: boolean
  selected: boolean
  collapsed: boolean
  flat: boolean
  parentName?: string
  onSelect: () => void
  onToggle: () => void
}) {
  return (
    <div className={`pick-row grp-placement-row${selected ? ' pick-row--on' : ''}`}>
      <button
        type="button"
        className="grp-placement-row__choice"
        role="option"
        aria-selected={selected}
        aria-label={option.path}
        title={option.path}
        onClick={onSelect}
        onKeyDown={moveOptionFocus}
      >
        {!flat && <PickGuides depth={depth} />}
        <span className={`pick-row__box${selected ? ' pick-row__box--on' : ''}`}>
          {selected ? '✓' : ''}
        </span>
        <span className="pick-row__name">{option.name}</span>
        {flat && parentName && <span className="pick-row__parent">{parentName}</span>}
      </button>
      {hasChildren ? (
        <button
          type="button"
          className="pick-row__toggle"
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} destination ${option.name}`}
          onClick={onToggle}
        >
          <IconChevron open={!collapsed} />
        </button>
      ) : (
        <span className="pick-row__toggle" aria-hidden="true" />
      )}
    </div>
  )
}

/** Render searchable, foldable destination choices while the popover is open */
function PlacementOptions({
  options,
  currentId,
  collapsed,
  loading,
  error,
  onSelect,
  onToggle,
}: {
  options: GroupingPlacementOption[]
  currentId: string | null | undefined
  collapsed: Set<string>
  loading: boolean
  error: boolean
  onSelect: (id: string | null) => void
  onToggle: (id: string) => void
}) {
  const [search, setSearch] = useState('')
  const matchSearch = usePinyinSearch(search)
  const trimmedSearch = search.trim()
  const byId = new Map(options.map((option) => [option.id, option]))
  const matches = trimmedSearch ? options.filter((option) => matchSearch(option.name)) : options
  const rows = trimmedSearch
    ? matches.map((item) => ({ item, depth: 0, hasChildren: false }))
    : visibleHierarchy(options, collapsed)
  const showTopLevel = !trimmedSearch || matchSearch('Top level')
  const normalizedSearch = trimmedSearch.normalize('NFKC').toLocaleLowerCase()
  const exact = matches.find(
    (option) => option.name.normalize('NFKC').toLocaleLowerCase() === normalizedSearch,
  )
  const enterTarget = exact ?? (matches.length === 1 ? matches[0] : undefined)

  return (
    <>
      <div className="picker__head grp-placement-panel__head">
        <input
          className="edit picker__search"
          placeholder="Search destinations…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              event.currentTarget
                .closest('.grp-placement-panel')
                ?.querySelector<HTMLButtonElement>('[role="option"]')
                ?.focus()
              return
            }
            if (event.key !== 'Enter' || !enterTarget) return
            event.preventDefault()
            onSelect(enterTarget.id)
          }}
          autoFocus
          aria-label="Search collection destinations"
        />
      </div>
      <div className="grp-placement-list" role="listbox" aria-label="Collection destinations">
        {showTopLevel && (
          <div className={`pick-row grp-placement-row${currentId === null ? ' pick-row--on' : ''}`}>
            <button
              type="button"
              className="grp-placement-row__choice"
              role="option"
              aria-selected={currentId === null}
              onClick={() => onSelect(null)}
              onKeyDown={moveOptionFocus}
            >
              <span className={`pick-row__box${currentId === null ? ' pick-row__box--on' : ''}`}>
                {currentId === null ? '✓' : ''}
              </span>
              <span className="pick-row__name">Top level</span>
            </button>
            <span className="pick-row__toggle" aria-hidden="true" />
          </div>
        )}
        {rows.map(({ item, depth, hasChildren }) => (
          <PlacementOptionRow
            key={item.id}
            option={item}
            depth={depth}
            hasChildren={hasChildren}
            selected={currentId === item.id}
            collapsed={collapsed.has(item.id)}
            flat={Boolean(trimmedSearch)}
            parentName={item.parent_id ? byId.get(item.parent_id)?.name : undefined}
            onSelect={() => onSelect(item.id)}
            onToggle={() => onToggle(item.id)}
          />
        ))}
        {!showTopLevel && rows.length === 0 && (
          <div className="pick-group">No matching destinations</div>
        )}
        {!trimmedSearch && loading && <div className="pick-group">Loading collections…</div>}
        {!trimmedSearch && error && <div className="pick-group">Could not load collections</div>}
        {!trimmedSearch && !loading && !error && rows.length === 0 && (
          <div className="pick-group">No collections yet</div>
        )}
      </div>
    </>
  )
}

/** Choose one persisted collection destination from a bounded hierarchy */
export function GroupingPlacementPicker({
  kind,
  title,
  currentId,
  currentLabel,
  currentPath,
  options,
  disabled,
  loading = false,
  error = false,
  onChange,
}: {
  kind: 'bundle' | 'collection'
  title: string
  currentId: string | null | undefined
  currentLabel?: string
  currentPath?: string
  options: GroupingPlacementOption[]
  disabled: boolean
  loading?: boolean
  error?: boolean
  onChange: (id: string | null) => void
}) {
  const { open, setOpen, ref, panelRef, pos } = usePopover()
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const current =
    typeof currentId === 'string' ? options.find((option) => option.id === currentId) : undefined
  const label = current?.name ?? (currentId === null ? 'Top level' : currentLabel)
  const path = current?.path ?? (currentId === null ? 'Top level' : currentPath)

  const select = (id: string | null) => {
    setOpen(false)
    if (id !== currentId) onChange(id)
  }

  const toggle = (id: string) =>
    setCollapsed((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <div className="grp-placement-picker" ref={ref}>
      <button
        type="button"
        className="grp-placement"
        aria-label={`Placement for ${kind} suggestion ${title}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={`Current placement: ${path ?? 'Suggested hierarchy'}`}
        disabled={disabled}
        draggable={false}
        onMouseDown={(event) => event.stopPropagation()}
        onDragStart={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation()
          setOpen((value) => !value)
        }}
      >
        <IconFolder />
        <span className="grp-placement__label">{label ?? 'Suggested hierarchy'}</span>
        <IconChevron open={open} />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            className="picker__panel grp-placement-panel"
            ref={panelRef}
            role="dialog"
            aria-label={`Place ${kind} suggestion ${title}`}
            style={{
              top: pos.top,
              bottom: pos.bottom,
              right: pos.right,
              maxHeight: pos.maxHeight,
            }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <PlacementOptions
              options={options}
              currentId={currentId}
              collapsed={collapsed}
              loading={loading}
              error={error}
              onSelect={select}
              onToggle={toggle}
            />
          </div>,
          document.body,
        )}
    </div>
  )
}

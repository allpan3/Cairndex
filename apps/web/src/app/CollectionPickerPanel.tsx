import { useState } from 'react'

import type { CollectionRead } from '../api/client'
import { useCollections, useCreateCollection } from '../api/hooks'
import { usePersistentState } from '../state/usePersistentState'
import { IconCheckSquare } from './icons'
import { PickGuides } from './PickGuides'
import { usePinyinSearch } from './pinyin'
import { flattenHierarchy, visibleHierarchy } from './usePopover'

interface CollectionRow {
  item: CollectionRead
  depth: number
  hasChildren: boolean
}

const RECENT_LIMIT = 6
const NONE: ReadonlySet<string> = new Set()

/**
 * v0.2.1's collection picker panel: pinyin search, "only selected", recently used
 * collections, then the whole collection tree (by name at each level) with
 * folding, the shown Enter target, and "Create" for a new top-level collection.
 *
 * One panel for a bundle and a selection of bundles. It is mounted only while
 * open, so reopening starts from a clean search. The collections come from the
 * shared hooks, which read the portable catalog inside a `CatalogQueryContext`.
 */
export function CollectionPickerPanel({
  assigned,
  partial = NONE,
  disabled = false,
  onToggle,
  onCreated,
}: {
  /** Collections every target is in. */
  assigned: ReadonlySet<string>
  /** Collections only some of a selection are in: shown with a dash, and picking one adds all. */
  partial?: ReadonlySet<string>
  disabled?: boolean
  onToggle: (id: string, assign: boolean) => void
  /** A collection the panel just made, for the caller to assign. */
  onCreated: (collection: CollectionRead) => void
}) {
  const { data: collections = [] } = useCollections()
  const createCollection = useCreateCollection()
  const [search, setSearch] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [onlySelected, setOnlySelected] = useState(false)
  // Recently-used collection ids (most recent first), shared across bundles.
  const [recentIds, setRecentIds] = usePersistentState<string[]>('cairndex.recentCollections', [])

  const byId = new Map(collections.map((c) => [c.id, c]))
  const remember = (id: string) =>
    setRecentIds([id, ...recentIds.filter((r) => r !== id)].slice(0, 20))

  const toggle = (id: string) => {
    if (disabled) return
    onToggle(id, !assigned.has(id))
    remember(id)
  }

  const trimmedSearch = search.trim()
  const matchSearch = usePinyinSearch(search)
  // "Create <search>" offers a *new* collection with this exact name — shown
  // whenever the search doesn't already name an existing collection exactly,
  // even if it's a substring of one (e.g. searching "Movie" while "Movies"
  // exists should still offer to create "Movie" as its own collection).
  const hasExactMatch = collections.some(
    (c) => c.name.toLowerCase() === trimmedSearch.toLowerCase(),
  )

  // Make a new top-level collection and assign it immediately, same as
  // picking an existing row.
  const handleCreate = (name: string) => {
    if (disabled) return
    createCollection.mutate(
      { name, parent_id: null, existing: collections },
      {
        onSuccess: (created) => {
          onCreated(created)
          remember(created.id)
        },
      },
    )
    setSearch('')
  }

  const toggleCollapse = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // The full tree, by name at each level. While searching, flatten and filter so matches
  // are never hidden inside a collapsed branch; when "only selected" is on, show
  // just the chosen rows (still in tree order).
  let rows: CollectionRow[]
  if (search) {
    rows = flattenHierarchy(collections)
      .filter(({ item }) => matchSearch(item.name))
      .map(({ item }) => ({ item, depth: 0, hasChildren: false }))
  } else if (onlySelected) {
    rows = flattenHierarchy(collections)
      .filter(({ item }) => assigned.has(item.id) || partial.has(item.id))
      .map(({ item }) => ({ item, depth: 0, hasChildren: false }))
  } else {
    rows = visibleHierarchy(collections, collapsed)
  }

  // What Enter will take, decided once and rendered from the same value — the
  // single match when the search narrows to one, an exact name if there is one,
  // else "create what I typed" (owner, 2026-07-27).
  const enterTarget: CollectionRead | 'create' | null = (() => {
    if (!trimmedSearch) return null
    const matches = collections.filter((c) => matchSearch(c.name))
    const exact = matches.find((c) => c.name.toLowerCase() === trimmedSearch.toLowerCase())
    if (exact) return exact
    if (matches.length === 1 && matches[0]) return matches[0]
    return 'create'
  })()

  const acceptSearch = () => {
    if (enterTarget === null) return
    if (enterTarget === 'create') {
      handleCreate(trimmedSearch)
      return
    }
    if (!assigned.has(enterTarget.id)) toggle(enterTarget.id)
    setSearch('')
  }

  // Recent collections (resolved + still-existing), hidden while searching or
  // filtering to selected.
  const recent =
    search || onlySelected
      ? []
      : recentIds
          .map((id) => byId.get(id))
          .filter((c) => c !== undefined)
          .slice(0, RECENT_LIMIT)

  const renderRow = ({ item, depth, hasChildren }: CollectionRow, key: string) => {
    const on = assigned.has(item.id)
    const some = !on && partial.has(item.id)
    const isEnterTarget = enterTarget !== 'create' && enterTarget?.id === item.id
    const parent = item.parent_id ? byId.get(item.parent_id) : undefined
    return (
      <div
        key={key}
        className={`pick-row${on ? ' pick-row--on' : ''}${
          isEnterTarget ? ' pick-row--target' : ''
        }`}
      >
        {/* A toggle button rather than a listbox option: each row acts at once,
            and Tab reaches every one without a roving focus */}
        <button
          className="pick-row__pick"
          aria-pressed={on ? true : some ? 'mixed' : false}
          disabled={disabled}
          onClick={() => toggle(item.id)}
        >
          <PickGuides depth={depth} />
          <span className={`pick-row__box${on ? ' pick-row__box--on' : ''}`} aria-hidden="true">
            {on ? '✓' : some ? '–' : ''}
          </span>
          <span className="pick-row__name">{item.name}</span>
          {parent && <span className="pick-row__parent">{parent.name}</span>}
        </button>
        {/* The chevron slot is always reserved (empty for leaf rows) so the
            right-aligned parent label never shifts between rows. */}
        {hasChildren ? (
          <button
            className="pick-row__toggle"
            onClick={() => toggleCollapse(item.id)}
            aria-label={collapsed.has(item.id) ? 'Expand' : 'Collapse'}
          >
            {collapsed.has(item.id) ? '›' : '⌄'}
          </button>
        ) : (
          <span className="pick-row__toggle" aria-hidden="true" />
        )}
      </div>
    )
  }

  return (
    <>
      <div className="picker__head">
        <input
          className="edit picker__search"
          placeholder="Search collections…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            e.preventDefault()
            acceptSearch()
          }}
          autoFocus
          aria-label="Search collections"
        />
        <button
          className={`picker__filter${onlySelected ? ' picker__filter--on' : ''}`}
          onClick={() => setOnlySelected((v) => !v)}
          aria-pressed={onlySelected}
          title={onlySelected ? 'Show all collections' : 'Show only selected'}
          aria-label="Show only selected"
        >
          <IconCheckSquare />
        </button>
      </div>

      {recent.length > 0 && (
        <>
          <div className="pick-group">Recent</div>
          {recent.map((c) =>
            renderRow({ item: c, depth: 0, hasChildren: false }, `recent-${c.id}`),
          )}
          <div className="pick-divider" />
        </>
      )}

      {rows.length === 0 && (trimmedSearch === '' || onlySelected) && (
        <div className="pick-group">
          {onlySelected ? 'No collections selected' : 'No matching collections'}
        </div>
      )}
      {rows.map((row) => renderRow(row, row.item.id))}
      {trimmedSearch !== '' && !hasExactMatch && (
        <button
          className={`pick-row pick-row--create${enterTarget === 'create' ? ' pick-row--target' : ''}`}
          disabled={disabled || createCollection.isPending}
          onClick={() => handleCreate(trimmedSearch)}
        >
          <span className="pick-row__create-icon" aria-hidden="true">
            +
          </span>
          <span className="pick-row__name">Create &ldquo;{trimmedSearch}&rdquo;</span>
        </button>
      )}
      {createCollection.error && <p className="modal__error">{createCollection.error.message}</p>}
    </>
  )
}

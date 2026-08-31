import { useState } from 'react'
import { createPortal } from 'react-dom'

import type { CollectionRead } from '../api/client'
import {
  useBundleCollections,
  useCollections,
  useCreateCollection,
  useSetBundleCollections,
} from '../api/hooks'
import { usePersistentState } from '../state/usePersistentState'
import { useBundleInspectorActions } from './bundleInspectorActions'
import { IconCheckSquare } from './icons'
import { PickGuides } from './PickGuides'
import { usePinyinSearch } from './pinyin'
import { flattenHierarchy, usePopover, visibleHierarchy } from './usePopover'

interface CollectionRow {
  item: CollectionRead
  depth: number
  hasChildren: boolean
}

const RECENT_LIMIT = 6

export function CollectionPicker({ bundleId }: { bundleId: string }) {
  const { onOpenCollection } = useBundleInspectorActions()
  const { data: bundleCollections } = useBundleCollections(bundleId)
  const { data: collections = [] } = useCollections()
  const setCollections = useSetBundleCollections(bundleId)
  const createCollection = useCreateCollection()
  const { open, setOpen, ref, panelRef, pos } = usePopover()
  const [search, setSearch] = useState('')

  // Dismissing throws away what was typed: reopening the picker should present
  // a clean field, not last time's half-finished search (owner, 2026-07-27).
  // Compared during render rather than synced in an effect, so the stale text
  // never paints. Catches every close — click away, Escape, or the anchor.
  const [wasOpen, setWasOpen] = useState(open)
  if (wasOpen !== open) {
    setWasOpen(open)
    if (!open) setSearch('')
  }
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [onlySelected, setOnlySelected] = useState(false)
  // Recently-used collection ids (most recent first), shared across bundles.
  const [recentIds, setRecentIds] = usePersistentState<string[]>('cairndex.recentCollections', [])

  const assigned = new Set(bundleCollections?.collection_ids ?? [])
  const byId = new Map(collections.map((c) => [c.id, c]))

  const toggle = (id: string) => {
    const next = new Set(assigned)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setCollections.mutate([...next])
    setRecentIds([id, ...recentIds.filter((r) => r !== id)].slice(0, 20))
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
    createCollection.mutate(
      { name, parent_id: null },
      {
        onSuccess: (created) => {
          setCollections.mutate([...assigned, created.id])
          setRecentIds([created.id, ...recentIds.filter((r) => r !== created.id)].slice(0, 20))
        },
      },
    )
  }

  const toggleCollapse = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // Bottom section: the full tree (sidebar order). While searching, flatten and
  // filter so matches are never hidden inside a collapsed branch; when "only
  // selected" is on, show just the assigned rows (still in tree order).
  // Only while the panel is on screen: this walks and sorts every collection in
  // the library, and the viewer docks this inspector beside a playing video
  // (2026-07-27).
  let rows: CollectionRow[]
  if (!open) {
    rows = []
  } else if (search) {
    rows = flattenHierarchy(collections)
      .filter(({ item }) => matchSearch(item.name))
      .map(({ item }) => ({ item, depth: 0, hasChildren: false }))
  } else if (onlySelected) {
    rows = flattenHierarchy(collections)
      .filter(({ item }) => assigned.has(item.id))
      .map(({ item }) => ({ item, depth: 0, hasChildren: false }))
  } else {
    rows = visibleHierarchy(collections, collapsed)
  }

  // What Enter will take, decided once and rendered from the same value — the
  // single match when the search narrows to one, an exact name if there is one,
  // else "create what I typed". The tag picker has had this since round 3; the
  // owner reported Enter doing nothing here (2026-07-27).
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
      setSearch('')
      return
    }
    if (!assigned.has(enterTarget.id)) toggle(enterTarget.id)
    setSearch('')
  }

  // Top section: recent collections (resolved + still-existing), hidden while
  // searching or filtering to selected.
  const recent =
    search || onlySelected
      ? []
      : recentIds
          .map((id) => byId.get(id))
          .filter((c) => c !== undefined)
          .slice(0, RECENT_LIMIT)

  const Row = ({ item, depth, hasChildren }: CollectionRow) => {
    const on = assigned.has(item.id)
    const isEnterTarget = enterTarget !== 'create' && enterTarget?.id === item.id
    const parent = item.parent_id ? byId.get(item.parent_id) : undefined
    return (
      <div
        className={`pick-row${on ? ' pick-row--on' : ''}${
          isEnterTarget ? ' pick-row--target' : ''
        }`}
        onClick={() => toggle(item.id)}
        role="option"
        aria-selected={on}
      >
        <PickGuides depth={depth} />
        <span className={`pick-row__box${on ? ' pick-row__box--on' : ''}`}>{on ? '✓' : ''}</span>
        <span className="pick-row__name">{item.name}</span>
        {parent && <span className="pick-row__parent">{parent.name}</span>}
        {/* The chevron slot is always reserved (empty for leaf rows) so the
            right-aligned parent label never shifts between rows. */}
        {hasChildren ? (
          <button
            className="pick-row__toggle"
            onClick={(e) => {
              e.stopPropagation()
              toggleCollapse(item.id)
            }}
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
      <div className="chips">
        {[...assigned]
          .map((id) => byId.get(id))
          .filter((c) => c !== undefined)
          .map((c) => (
            <span className="chip chip--collection" key={c.id}>
              <button
                className="chip__open"
                onClick={() => onOpenCollection?.(c.id)}
                disabled={!onOpenCollection}
                aria-label={`Open collection ${c.name}`}
                title={`Open ${c.name}`}
              >
                {c.name}
              </button>
              <button
                className="chip__remove"
                onClick={() => toggle(c.id)}
                aria-label={`Remove from ${c.name}`}
              >
                ×
              </button>
            </span>
          ))}
        <div className="picker" ref={ref}>
          <button className="add-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            + Collection
          </button>
          {open &&
            pos &&
            createPortal(
              <div
                className="picker__panel"
                ref={panelRef}
                style={{
                  top: pos.top,
                  bottom: pos.bottom,
                  right: pos.right,
                  maxHeight: pos.maxHeight,
                }}
              >
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
                    {recent.map((c) => (
                      <Row key={`recent-${c.id}`} item={c} depth={0} hasChildren={false} />
                    ))}
                    <div className="pick-divider" />
                  </>
                )}

                {rows.length === 0 && (trimmedSearch === '' || onlySelected) && (
                  <div className="pick-group">
                    {onlySelected ? 'No collections selected' : 'No matching collections'}
                  </div>
                )}
                {rows.map((row) => (
                  <Row key={row.item.id} {...row} />
                ))}
                {trimmedSearch !== '' && !hasExactMatch && (
                  <div
                    className={`pick-row pick-row--create${
                      enterTarget === 'create' ? ' pick-row--target' : ''
                    }`}
                    onClick={() => {
                      handleCreate(trimmedSearch)
                      setSearch('')
                    }}
                    role="option"
                    aria-selected={false}
                  >
                    <span className="pick-row__create-icon">+</span>
                    <span className="pick-row__name">Create &ldquo;{trimmedSearch}&rdquo;</span>
                  </div>
                )}
              </div>,
              document.body,
            )}
        </div>
      </div>
    </>
  )
}

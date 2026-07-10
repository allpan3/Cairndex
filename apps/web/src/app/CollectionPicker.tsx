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
import { IconCheckSquare } from './icons'
import { PickGuides } from './PickGuides'
import { usePinyinSearch } from './pinyin'
import { flattenHierarchy, usePopover } from './usePopover'

interface CollectionRow {
  item: CollectionRead
  depth: number
  hasChildren: boolean
}

const RECENT_LIMIT = 6

/** Depth-first collection rows (sidebar order), skipping descendants of any
 * collapsed row. */
function visibleCollectionRows(
  collections: CollectionRead[],
  collapsed: Set<string>,
): CollectionRow[] {
  const byParent = new Map<string | null, CollectionRead[]>()
  for (const c of collections) {
    const key = c.parent_id ?? null
    byParent.set(key, [...(byParent.get(key) ?? []), c])
  }
  const out: CollectionRow[] = []
  const walk = (parent: string | null, depth: number) => {
    for (const c of (byParent.get(parent) ?? []).sort((a, b) => a.name.localeCompare(b.name))) {
      const hasChildren = (byParent.get(c.id) ?? []).length > 0
      out.push({ item: c, depth, hasChildren })
      if (hasChildren && !collapsed.has(c.id)) walk(c.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}

export function CollectionPicker({ bundleId }: { bundleId: string }) {
  const { data: bundleCollections } = useBundleCollections(bundleId)
  const { data: collections = [] } = useCollections()
  const setCollections = useSetBundleCollections(bundleId)
  const createCollection = useCreateCollection()
  const { open, setOpen, ref, panelRef, pos } = usePopover()
  const [search, setSearch] = useState('')
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
  let rows: CollectionRow[]
  if (search) {
    rows = flattenHierarchy(collections)
      .filter(({ item }) => matchSearch(item.name))
      .map(({ item }) => ({ item, depth: 0, hasChildren: false }))
  } else if (onlySelected) {
    rows = flattenHierarchy(collections)
      .filter(({ item }) => assigned.has(item.id))
      .map(({ item }) => ({ item, depth: 0, hasChildren: false }))
  } else {
    rows = visibleCollectionRows(collections, collapsed)
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
    const parent = item.parent_id ? byId.get(item.parent_id) : undefined
    return (
      <div
        className={`pick-row${on ? ' pick-row--on' : ''}`}
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
      <label className="field-label">Collections</label>
      <div className="chips">
        {[...assigned]
          .map((id) => byId.get(id))
          .filter((c) => c !== undefined)
          .map((c) => (
            <span className="chip" key={c.id}>
              {c.name}
              <button onClick={() => toggle(c.id)} aria-label={`Remove from ${c.name}`}>
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
                    className="pick-row pick-row--create"
                    onClick={() => handleCreate(trimmedSearch)}
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

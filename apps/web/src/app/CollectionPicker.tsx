import { useState } from 'react'
import { createPortal } from 'react-dom'

import type { CollectionRead } from '../api/client'
import { useBundleCollections, useCollections, useSetBundleCollections } from '../api/hooks'
import { flattenHierarchy, usePopover } from './usePopover'

interface CollectionRow {
  item: CollectionRead
  depth: number
  hasChildren: boolean
}

/** Depth-first collection rows, skipping descendants of any collapsed row. */
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
  const { open, setOpen, ref, panelRef, pos } = usePopover()
  const [search, setSearch] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const assigned = new Set(bundleCollections?.collection_ids ?? [])
  const byId = new Map(collections.map((c) => [c.id, c]))

  const toggle = (id: string) => {
    const next = new Set(assigned)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setCollections.mutate([...next])
  }

  const toggleCollapse = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // While searching, flatten the whole tree and filter — collapse is ignored so
  // matches are never hidden inside a collapsed branch.
  const rows: CollectionRow[] = search
    ? flattenHierarchy(collections)
        .filter(({ item }) => item.name.toLowerCase().includes(search.toLowerCase()))
        .map(({ item, depth }) => ({ item, depth, hasChildren: false }))
    : visibleCollectionRows(collections, collapsed)

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
                style={{ top: pos.top, right: pos.right }}
              >
                <input
                  className="edit picker__search"
                  placeholder="Search collections…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  autoFocus
                  aria-label="Search collections"
                />
                {rows.length === 0 && <div className="pick-group">No matching collections</div>}
                {rows.map(({ item, depth, hasChildren }) => (
                  <div
                    key={item.id}
                    className={`pick-row${assigned.has(item.id) ? ' pick-row--on' : ''}`}
                    style={{ paddingLeft: 6 + depth * 14 }}
                    onClick={() => toggle(item.id)}
                    role="option"
                    aria-selected={assigned.has(item.id)}
                  >
                    <button
                      className="pick-row__toggle"
                      onClick={(e) => {
                        e.stopPropagation()
                        toggleCollapse(item.id)
                      }}
                      aria-label={collapsed.has(item.id) ? 'Expand' : 'Collapse'}
                      tabIndex={hasChildren ? 0 : -1}
                    >
                      {hasChildren ? (collapsed.has(item.id) ? '›' : '⌄') : ''}
                    </button>
                    <span className="pick-row__check">{assigned.has(item.id) ? '✓' : ''}</span>
                    <span>🗀 {item.name}</span>
                    {item.parent_id && byId.get(item.parent_id) && (
                      <span className="pick-row__parent">{byId.get(item.parent_id)!.name}</span>
                    )}
                  </div>
                ))}
              </div>,
              document.body,
            )}
        </div>
      </div>
    </>
  )
}

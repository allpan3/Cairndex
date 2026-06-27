import { useState } from 'react'
import { createPortal } from 'react-dom'

import type { FolderRead } from '../api/client'
import { useBundleFolders, useFolderCounts, useFolders, useSetBundleFolders } from '../api/hooks'
import { flattenHierarchy, usePopover } from './usePopover'

interface FolderRow {
  item: FolderRead
  depth: number
  hasChildren: boolean
}

/** Depth-first folder rows, skipping descendants of any collapsed folder. */
function visibleFolderRows(folders: FolderRead[], collapsed: Set<string>): FolderRow[] {
  const byParent = new Map<string | null, FolderRead[]>()
  for (const f of folders) {
    const key = f.parent_id ?? null
    byParent.set(key, [...(byParent.get(key) ?? []), f])
  }
  const out: FolderRow[] = []
  const walk = (parent: string | null, depth: number) => {
    for (const f of (byParent.get(parent) ?? []).sort((a, b) => a.name.localeCompare(b.name))) {
      const hasChildren = (byParent.get(f.id) ?? []).length > 0
      out.push({ item: f, depth, hasChildren })
      if (hasChildren && !collapsed.has(f.id)) walk(f.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}

export function FolderPicker({ bundleId }: { bundleId: string }) {
  const { data: bundleFolders } = useBundleFolders(bundleId)
  const { data: folders = [] } = useFolders()
  const { data: counts = {} } = useFolderCounts()
  const setFolders = useSetBundleFolders(bundleId)
  const { open, setOpen, ref, panelRef, pos } = usePopover()
  const [search, setSearch] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const assigned = new Set(bundleFolders?.folder_ids ?? [])
  const byId = new Map(folders.map((f) => [f.id, f]))

  const toggle = (id: string) => {
    const next = new Set(assigned)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setFolders.mutate([...next])
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
  const rows: FolderRow[] = search
    ? flattenHierarchy(folders)
        .filter(({ item }) => item.name.toLowerCase().includes(search.toLowerCase()))
        .map(({ item, depth }) => ({ item, depth, hasChildren: false }))
    : visibleFolderRows(folders, collapsed)

  return (
    <>
      <label className="field-label">Folders</label>
      <div className="chips">
        {[...assigned]
          .map((id) => byId.get(id))
          .filter((f) => f !== undefined)
          .map((f) => (
            <span className="chip" key={f.id}>
              {f.name}
              <button onClick={() => toggle(f.id)} aria-label={`Remove from ${f.name}`}>
                ×
              </button>
            </span>
          ))}
        <div className="picker" ref={ref}>
          <button className="add-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            + Folder
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
                  placeholder="Search folders…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  autoFocus
                  aria-label="Search folders"
                />
                {rows.length === 0 && <div className="pick-group">No matching folders</div>}
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
                      {hasChildren ? (collapsed.has(item.id) ? '▸' : '▾') : ''}
                    </button>
                    <span className="pick-row__check">{assigned.has(item.id) ? '✓' : ''}</span>
                    <span>🗀 {item.name}</span>
                    <span className="pick-row__count">{counts[item.id] ?? 0}</span>
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

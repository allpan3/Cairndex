import { useState } from 'react'

import { useBundleFolders, useFolderCounts, useFolders, useSetBundleFolders } from '../api/hooks'
import { flattenHierarchy, usePopover } from './usePopover'

export function FolderPicker({ bundleId }: { bundleId: string }) {
  const { data: bundleFolders } = useBundleFolders(bundleId)
  const { data: folders = [] } = useFolders()
  const { data: counts = {} } = useFolderCounts()
  const setFolders = useSetBundleFolders(bundleId)
  const { open, setOpen, ref } = usePopover()
  const [search, setSearch] = useState('')

  const assigned = new Set(bundleFolders?.folder_ids ?? [])
  const byId = new Map(folders.map((f) => [f.id, f]))

  const toggle = (id: string) => {
    const next = new Set(assigned)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setFolders.mutate([...next])
  }

  const rows = flattenHierarchy(folders).filter(
    ({ item }) => !search || item.name.toLowerCase().includes(search.toLowerCase()),
  )

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
          {open && (
            <div className="picker__panel">
              <input
                className="edit picker__search"
                placeholder="Search folders…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                autoFocus
                aria-label="Search folders"
              />
              {rows.length === 0 && <div className="pick-group">No matching folders</div>}
              {rows.map(({ item, depth }) => (
                <div
                  key={item.id}
                  className={`pick-row${assigned.has(item.id) ? ' pick-row--on' : ''}`}
                  style={{ paddingLeft: 6 + depth * 14 }}
                  onClick={() => toggle(item.id)}
                  role="option"
                  aria-selected={assigned.has(item.id)}
                >
                  <span className="pick-row__check">{assigned.has(item.id) ? '✓' : ''}</span>
                  <span>🗀 {item.name}</span>
                  <span className="pick-row__count">{counts[item.id] ?? 0}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  )
}

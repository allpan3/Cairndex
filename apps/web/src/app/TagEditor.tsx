import { useState } from 'react'

import {
  useBundleTags,
  useSetBundleTags,
  useTagCounts,
  useTagGroupMemberships,
  useTagGroups,
  useTags,
} from '../api/hooks'
import { flattenHierarchy, usePopover } from './usePopover'

export function TagEditor({ bundleId }: { bundleId: string }) {
  const { data: bundleTags } = useBundleTags(bundleId)
  const { data: tags = [] } = useTags()
  const { data: counts = {} } = useTagCounts()
  const { data: groups = [] } = useTagGroups()
  const { data: memberships = {} } = useTagGroupMemberships()
  const setTags = useSetBundleTags(bundleId)
  const { open, setOpen, ref } = usePopover()
  const [search, setSearch] = useState('')
  const [groupFilter, setGroupFilter] = useState<string | null>(null)

  const assigned = new Set(bundleTags?.tag_ids ?? [])
  const byId = new Map(tags.map((t) => [t.id, t]))

  const toggle = (id: string) => {
    const next = new Set(assigned)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setTags.mutate([...next])
  }

  const rows = flattenHierarchy(tags).filter(({ item }) => {
    if (search && !item.name.toLowerCase().includes(search.toLowerCase())) return false
    if (groupFilter && !(memberships[groupFilter] ?? []).includes(item.id)) return false
    return true
  })

  return (
    <>
      <label className="field-label">Tags</label>
      <div className="chips">
        {[...assigned]
          .map((id) => byId.get(id))
          .filter((t) => t !== undefined)
          .map((t) => (
            <span className="chip" key={t.id}>
              {t.name}
              <button onClick={() => toggle(t.id)} aria-label={`Remove ${t.name}`}>
                ×
              </button>
            </span>
          ))}
        <div className="picker" ref={ref}>
          <button className="add-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            + Tag
          </button>
          {open && (
            <div className="picker__panel">
              <input
                className="edit picker__search"
                placeholder="Search tags…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                autoFocus
                aria-label="Search tags"
              />
              {groups.length > 0 && (
                <div className="chips">
                  <button
                    className={`add-btn${groupFilter === null ? ' is-active' : ''}`}
                    onClick={() => setGroupFilter(null)}
                  >
                    All
                  </button>
                  {groups.map((g) => (
                    <button
                      key={g.id}
                      className={`add-btn${groupFilter === g.id ? ' is-active' : ''}`}
                      onClick={() => setGroupFilter(g.id)}
                    >
                      {g.name}
                    </button>
                  ))}
                </div>
              )}
              {rows.length === 0 && <div className="pick-group">No matching tags</div>}
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
                  <span>{item.name}</span>
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

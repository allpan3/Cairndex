import { useState } from 'react'
import { createPortal } from 'react-dom'

import type { TagRead } from '../api/client'
import {
  useBundleTags,
  useSetBundleTags,
  useTagCounts,
  useTagGroupMemberships,
  useTagGroups,
  useTags,
} from '../api/hooks'
import { flattenHierarchy, usePopover } from './usePopover'

interface TagRow {
  item: TagRead
  depth: number
}

interface Section {
  key: string
  title: string
  rows: TagRow[]
}

export function TagEditor({ bundleId }: { bundleId: string }) {
  const { data: bundleTags } = useBundleTags(bundleId)
  const { data: tags = [] } = useTags()
  const { data: counts = {} } = useTagCounts()
  const { data: groups = [] } = useTagGroups()
  const { data: memberships = {} } = useTagGroupMemberships()
  const setTags = useSetBundleTags(bundleId)
  const { open, setOpen, ref, panelRef, pos } = usePopover()
  const [search, setSearch] = useState('')
  const [groupFilter, setGroupFilter] = useState<string | null>(null)
  const [filterExpanded, setFilterExpanded] = useState(false)

  const assigned = new Set(bundleTags?.tag_ids ?? [])
  const byId = new Map(tags.map((t) => [t.id, t]))

  const toggle = (id: string) => {
    const next = new Set(assigned)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setTags.mutate([...next])
  }

  const match = (t: TagRead) => !search || t.name.toLowerCase().includes(search.toLowerCase())
  const flat = flattenHierarchy(tags)
  const groupedIds = new Set(Object.values(memberships).flat())

  // First section: the currently selected tags (shown flat for quick removal).
  // They also stay visible/highlighted in their group sections below.
  const sections: Section[] = []
  const selectedRows = [...assigned]
    .map((id) => byId.get(id))
    .filter((t): t is TagRead => t !== undefined && match(t))
    .map((item) => ({ item, depth: 0 }))
  if (selectedRows.length > 0)
    sections.push({ key: '__selected', title: 'Selected', rows: selectedRows })

  // One section per group (respecting the filter row), preserving hierarchy.
  for (const g of groups) {
    if (groupFilter !== null && groupFilter !== g.id) continue
    const member = new Set(memberships[g.id] ?? [])
    const rows = flat.filter(({ item }) => member.has(item.id) && match(item))
    if (rows.length > 0) sections.push({ key: g.id, title: g.name, rows })
  }

  // Tags with no group fall into a synthetic "Others" section.
  if (groupFilter === null) {
    const rows = flat.filter(({ item }) => !groupedIds.has(item.id) && match(item))
    if (rows.length > 0) sections.push({ key: '__others', title: 'Others', rows })
  }

  const renderRow = ({ item, depth }: TagRow) => (
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
  )

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
                  placeholder="Search tags…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  autoFocus
                  aria-label="Search tags"
                />
                {groups.length > 0 && (
                  <div className={`pick-filter${filterExpanded ? ' pick-filter--expanded' : ''}`}>
                    <div className="pick-filter__chips">
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
                    <button
                      className="pick-filter__toggle"
                      onClick={() => setFilterExpanded((v) => !v)}
                      aria-label={filterExpanded ? 'Collapse filters' : 'Expand filters'}
                      aria-expanded={filterExpanded}
                    >
                      {filterExpanded ? '▴' : '▾'}
                    </button>
                  </div>
                )}
                {sections.length === 0 && <div className="pick-group">No matching tags</div>}
                {sections.map((section) => (
                  <section className="pick-section" key={section.key}>
                    <div className="pick-section__title">{section.title}</div>
                    {section.rows.map(renderRow)}
                  </section>
                ))}
              </div>,
              document.body,
            )}
        </div>
      </div>
    </>
  )
}

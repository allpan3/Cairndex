import { useState } from 'react'
import { createPortal } from 'react-dom'

import type { TagRead } from '../api/client'
import {
  useBundleTags,
  useCreateTag,
  useSetBundleTags,
  useTagCounts,
  useTagGroupMemberships,
  useTagGroups,
  useTags,
} from '../api/hooks'
import { PickGuides } from './PickGuides'
import { flattenHierarchy, usePopover, visibleHierarchy } from './usePopover'

interface TagRow {
  item: TagRead
  depth: number
  hasChildren: boolean
  label?: string
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
  const createTag = useCreateTag()
  const { open, setOpen, ref, panelRef, pos } = usePopover()
  const [search, setSearch] = useState('')
  const [groupFilter, setGroupFilter] = useState<string | null>(null)
  const [filterExpanded, setFilterExpanded] = useState(false)
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set())
  // Folded parent tags (hierarchy fold, like the collection picker).
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const assigned = new Set(bundleTags?.tag_ids ?? [])
  const byId = new Map(tags.map((t) => [t.id, t]))

  const toggleSection = (key: string) =>
    setCollapsedSections((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const toggleCollapse = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  /** Full hierarchical path, e.g. "genre/comedy". */
  const pathOf = (t: TagRead): string => {
    const parts = [t.name]
    let parentId = t.parent_id
    while (parentId) {
      const parent = byId.get(parentId)
      if (!parent) break
      parts.unshift(parent.name)
      parentId = parent.parent_id
    }
    return parts.join('/')
  }

  const toggle = (id: string) => {
    const next = new Set(assigned)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setTags.mutate([...next])
  }

  // "Create <search>": make a new top-level tag and assign it immediately.
  const handleCreate = (name: string) => {
    createTag.mutate(
      { name },
      { onSuccess: (created) => setTags.mutate([...assigned, created.id]) },
    )
  }

  const match = (t: TagRead) => !search || t.name.toLowerCase().includes(search.toLowerCase())
  const trimmedSearch = search.trim()
  const hasExactMatch = tags.some((t) => t.name.toLowerCase() === trimmedSearch.toLowerCase())
  const groupedIds = new Set(Object.values(memberships).flat())

  // A section's rows: a foldable tree normally; while searching, a flat list of
  // matches so nothing hides inside a collapsed parent.
  const rowsForSection = (sectionTags: TagRead[]): TagRow[] =>
    trimmedSearch
      ? flattenHierarchy(sectionTags)
          .filter(({ item }) => match(item))
          .map(({ item }) => ({ item, depth: 0, hasChildren: false }))
      : visibleHierarchy(sectionTags, collapsed)

  // First section: the currently selected tags, shown flat with their full path.
  const sections: Section[] = []
  const filterMember = groupFilter !== null ? new Set(memberships[groupFilter] ?? []) : null
  const selectedRows: TagRow[] = [...assigned]
    .map((id) => byId.get(id))
    .filter(
      (t): t is TagRead =>
        t !== undefined && match(t) && (filterMember === null || filterMember.has(t.id)),
    )
    .map((item) => ({ item, depth: 0, hasChildren: false, label: pathOf(item) }))
  if (selectedRows.length > 0)
    sections.push({ key: '__selected', title: 'Selected', rows: selectedRows })

  // One section per group (respecting the filter row), as a foldable tree.
  for (const g of groups) {
    if (groupFilter !== null && groupFilter !== g.id) continue
    const memberIds = new Set(memberships[g.id] ?? [])
    const rows = rowsForSection(tags.filter((t) => memberIds.has(t.id)))
    if (rows.length > 0) sections.push({ key: g.id, title: g.name, rows })
  }

  // Tags with no group fall into a synthetic "Others" section.
  if (groupFilter === null) {
    const rows = rowsForSection(tags.filter((t) => !groupedIds.has(t.id)))
    if (rows.length > 0) sections.push({ key: '__others', title: 'Others', rows })
  }

  const renderRow = ({ item, depth, hasChildren, label }: TagRow) => {
    const on = assigned.has(item.id)
    return (
      <div
        key={item.id}
        className={`pick-row${on ? ' pick-row--on' : ''}`}
        onClick={() => toggle(item.id)}
        role="option"
        aria-selected={on}
      >
        <PickGuides depth={depth} />
        <span className={`pick-row__box${on ? ' pick-row__box--on' : ''}`}>{on ? '✓' : ''}</span>
        <span className="pick-row__name">{label ?? item.name}</span>
        <span className="pick-row__count">{counts[item.id] ?? 0}</span>
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
                style={{
                  top: pos.top,
                  bottom: pos.bottom,
                  right: pos.right,
                  maxHeight: pos.maxHeight,
                }}
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
                {sections.length === 0 && trimmedSearch === '' && (
                  <div className="pick-group">No matching tags</div>
                )}
                {sections.map((section) => {
                  const sectionCollapsed = collapsedSections.has(section.key)
                  return (
                    <section className="pick-section" key={section.key}>
                      <button
                        className="pick-section__title"
                        onClick={() => toggleSection(section.key)}
                        aria-expanded={!sectionCollapsed}
                      >
                        <span className="pick-row__toggle">{sectionCollapsed ? '›' : '⌄'}</span>
                        {section.title}
                      </button>
                      {!sectionCollapsed && section.rows.map(renderRow)}
                    </section>
                  )
                })}
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

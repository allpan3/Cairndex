import { useState } from 'react'

import type { TagRead } from '../api/client'
import {
  useCreateTagPath,
  useTagCounts,
  useTagGroupMemberships,
  useTagGroups,
  useTags,
} from '../api/hooks'
import { PickGuides } from './PickGuides'
import { usePinyinSearch } from './pinyin'
import { flattenHierarchy, visibleHierarchy } from './usePopover'

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

const NONE: ReadonlySet<string> = new Set()

/**
 * v0.2.1's tag picker panel: pinyin search, group filters, the chosen tags first,
 * then each group and Others as a foldable tree with counts, the shown Enter
 * target, and "Create" where `/` nests (`genre/noir` makes or reuses `genre`).
 *
 * One panel for a bundle, a moment and a selection of bundles, so they cannot
 * drift apart. It is mounted only while open, so reopening starts from a clean
 * search. The tag data comes from the shared hooks, which read the portable
 * catalog inside a `CatalogQueryContext`.
 */
export function TagPickerPanel({
  assigned,
  partial = NONE,
  disabled = false,
  onToggle,
  onCreated,
}: {
  /** Tags every target has. */
  assigned: ReadonlySet<string>
  /** Tags only some of a selection have: shown with a dash, and picking one adds it to all. */
  partial?: ReadonlySet<string>
  disabled?: boolean
  onToggle: (id: string, assign: boolean) => void
  /** A tag the panel just made, for the caller to assign. */
  onCreated: (tag: TagRead) => void
}) {
  const { data: tags = [] } = useTags()
  const { data: counts = {} } = useTagCounts()
  const { data: groups = [] } = useTagGroups()
  const { data: memberships = {} } = useTagGroupMemberships()
  const createTag = useCreateTagPath()
  const [search, setSearch] = useState('')
  const [groupFilter, setGroupFilter] = useState<string | null>(null)
  const [filterExpanded, setFilterExpanded] = useState(false)
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set())
  // Folded parent tags (hierarchy fold, like the collection picker).
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

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
    if (!disabled) onToggle(id, !assigned.has(id))
  }

  // "Create <search>": make a new tag and assign it immediately. The field clears
  // afterwards and the picker stays open, so the next tag can be typed straight
  // away instead of reopening (owner, 2026-07-27).
  const handleCreate = (name: string) => {
    if (disabled) return
    createTag.mutate(
      { path: name, existing: tags },
      {
        onSuccess: (created) => {
          onCreated(created)
          setSearch('')
        },
      },
    )
  }

  const matchSearch = usePinyinSearch(search)
  const match = (t: TagRead) => matchSearch(t.name)
  const trimmedSearch = search.trim()
  const hasExactMatch = tags.some((t) => t.name.toLowerCase() === trimmedSearch.toLowerCase())
  const groupedIds = new Set(Object.values(memberships).flat())

  // What Enter will take, decided once and *shown* — the owner could not tell
  // which row it meant otherwise (2026-07-27). The single match when the search
  // narrows to one, an exact name if there is one, else "create what I typed".
  const enterTarget = ((): TagRead | 'create' | null => {
    if (!trimmedSearch) return null
    const matches = tags.filter((t) => match(t))
    const exact = matches.find((t) => t.name.toLowerCase() === trimmedSearch.toLowerCase())
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
    if (!assigned.has(enterTarget.id) && !disabled) onToggle(enterTarget.id, true)
    setSearch('')
  }

  // A section's rows: a foldable tree normally; while searching, a flat list of
  // matches so nothing hides inside a collapsed parent.
  const rowsForSection = (sectionTags: TagRead[]): TagRow[] =>
    trimmedSearch
      ? flattenHierarchy(sectionTags)
          .filter(({ item }) => match(item))
          .map(({ item }) => ({ item, depth: 0, hasChildren: false }))
      : visibleHierarchy(sectionTags, collapsed)

  const sections: Section[] = []
  const filterMember = groupFilter !== null ? new Set(memberships[groupFilter] ?? []) : null
  const selectedRows: TagRow[] = [...assigned, ...partial]
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
    const some = !on && partial.has(item.id)
    const isEnterTarget = enterTarget !== 'create' && enterTarget?.id === item.id
    return (
      <div
        key={item.id}
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
          <span className="pick-row__name">{label ?? item.name}</span>
          <span className="pick-row__count">{counts[item.id] ?? 0}</span>
        </button>
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
      <input
        className="edit picker__search"
        placeholder="Search tags…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return
          e.preventDefault()
          acceptSearch()
        }}
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
        <button
          className={`pick-row pick-row--create${enterTarget === 'create' ? ' pick-row--target' : ''}`}
          disabled={disabled || createTag.isPending}
          onClick={() => handleCreate(trimmedSearch)}
        >
          <span className="pick-row__create-icon" aria-hidden="true">
            +
          </span>
          <span className="pick-row__name">Create &ldquo;{trimmedSearch}&rdquo;</span>
        </button>
      )}
      {createTag.error && <p className="modal__error">{createTag.error.message}</p>}
    </>
  )
}

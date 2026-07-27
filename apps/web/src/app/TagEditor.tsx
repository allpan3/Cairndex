import { useState } from 'react'
import { createPortal } from 'react-dom'

import type { TagRead } from '../api/client'
import {
  useBundleTags,
  useCreateTagPath,
  useSetBundleTags,
  useTagCounts,
  useTagGroupMemberships,
  useTagGroups,
  useTagMutations,
  useTags,
} from '../api/hooks'
import { ContextMenu } from './ContextMenu'
import { PromptDialog } from './PromptDialog'
import { PickGuides } from './PickGuides'
import { usePinyinSearch } from './pinyin'
import { getCopiedTags, setCopiedTags } from './tagClipboard'
import { useContextMenu } from './useContextMenu'
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

export function TagEditor({
  bundleId,
  onFilterByTags,
}: {
  bundleId: string
  /** Filter the library by these tags; undefined greys the menu row out. */
  onFilterByTags?: (tagIds: string[]) => void
}) {
  const { data: bundleTags } = useBundleTags(bundleId)
  const { data: tags = [] } = useTags()
  const { data: counts = {} } = useTagCounts()
  const { data: groups = [] } = useTagGroups()
  const { data: memberships = {} } = useTagGroupMemberships()
  const setTags = useSetBundleTags(bundleId)
  const createTag = useCreateTagPath()
  const { open, setOpen, ref, panelRef, pos } = usePopover()
  const menu = useContextMenu()
  const { rename } = useTagMutations()
  // The tag being renamed. A rendered dialog, because `window.prompt` returns
  // null in the desktop webview — which is why renaming "did not work" there
  // while it worked in the browser (owner, 2026-07-27).
  const [renaming, setRenaming] = useState<TagRead | null>(null)
  // Mirrored into state so the Paste row enables the moment something is
  // copied; the clipboard itself outlives this component.
  const [clipboard, setClipboard] = useState<string[]>(getCopiedTags)
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

  const assignedTags = () => [...assigned].map((id) => byId.get(id)).filter((t) => t !== undefined)

  const commitRename = (next: string) => {
    const tag = renaming
    setRenaming(null)
    if (!tag || next === tag.name) return
    rename.mutate({ id: tag.id, name: next, version: tag.version })
  }

  const pasteTags = () => {
    // Union, not replace: pasting adds what was copied and keeps what is here.
    const next = new Set([...assigned, ...clipboard])
    setTags.mutate([...next])
  }

  const copyTags = (ids: string[]) => {
    setCopiedTags(ids)
    setClipboard(ids)
  }

  const toggle = (id: string) => {
    const next = new Set(assigned)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setTags.mutate([...next])
  }

  // "Create <search>": make a new tag and assign it immediately. `/` nests —
  // typing `genre/noir` creates (or reuses) `genre` and puts `noir` under it.
  // The field clears afterwards and the picker stays open, so the next tag can
  // be typed straight away instead of reopening (owner, 2026-07-27).
  const handleCreate = (name: string) => {
    createTag.mutate(
      { path: name, existing: tags },
      {
        onSuccess: (created) => {
          setTags.mutate([...assigned, created.id])
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
    if (!assigned.has(enterTarget.id)) toggle(enterTarget.id)
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

  // Building the sections walks every tag in the library and sorts each level,
  // so it only runs when the panel is actually on screen. The viewer docks this
  // inspector beside a playing video, which re-renders several times a second
  // (2026-07-27).
  const sections: Section[] = []
  const filterMember = groupFilter !== null ? new Set(memberships[groupFilter] ?? []) : null
  if (open) {
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
  }

  const renderRow = ({ item, depth, hasChildren, label }: TagRow) => {
    const on = assigned.has(item.id)
    const isEnterTarget = enterTarget !== 'create' && enterTarget?.id === item.id
    return (
      <div
        key={item.id}
        className={`pick-row${on ? ' pick-row--on' : ''}${
          isEnterTarget ? ' pick-row--target' : ''
        }`}
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
      <ContextMenu state={menu.state} onClose={menu.close} />
      {renaming && (
        <PromptDialog
          title="Rename Tag"
          label="Tag name"
          initial={renaming.name}
          onCancel={() => setRenaming(null)}
          onConfirm={commitRename}
        />
      )}
      <div className="chips">
        {[...assigned]
          .map((id) => byId.get(id))
          .filter((t) => t !== undefined)
          .map((t) => (
            <span
              className="chip"
              key={t.id}
              // The actions the owner expects on a tag pill (2026-07-27).
              // "Filter" is the one that needs the shell — the rest act here.
              onContextMenu={(event) => {
                const chosen = assignedTags()
                menu.open(event, [
                  {
                    // The clicked tag only. There is no way to select several
                    // pills, so filtering by every tag on the bundle described
                    // the bundle rather than anything worth browsing (owner,
                    // 2026-07-27).
                    label: `Filter Items with “${t.name}”`,
                    disabled: !onFilterByTags,
                    onClick: () => onFilterByTags?.([t.id]),
                  },
                  null,
                  { label: 'Rename Tag…', onClick: () => setRenaming(t) },
                  { label: 'Copy Tags', onClick: () => copyTags(chosen.map((tag) => tag.id)) },
                  {
                    label: 'Paste Tags',
                    disabled: clipboard.length === 0,
                    onClick: () => pasteTags(),
                  },
                  null,
                  {
                    label: 'Remove from This Bundle',
                    onClick: () => toggle(t.id),
                  },
                ])
              }}
            >
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
                  <div
                    className={`pick-row pick-row--create${
                      enterTarget === 'create' ? ' pick-row--target' : ''
                    }`}
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

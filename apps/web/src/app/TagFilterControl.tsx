import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'

import type { TagRead } from '../api/client'
import { useFacets, useTagGroupMemberships, useTagGroups, useTags } from '../api/hooks'
import {
  type AdHocFilters,
  type FacetContext,
  type TagRule,
  adHocFiltersToExpression,
  combineFilters,
  tagFilterActive,
  withoutCategory,
} from './adHocFilters'
import { IconTag } from './icons'
import { PickGuides } from './PickGuides'
import { usePopover, visibleHierarchy } from './usePopover'

const RULES: { value: TagRule; label: string; title: string }[] = [
  { value: 'any', label: 'Any', title: 'Match any selected tag (contains_any)' },
  { value: 'all', label: 'All', title: 'Match all selected tags (contains_all)' },
  { value: 'equal', label: 'Equal', title: 'Exact direct membership only (no subtags)' },
]

/**
 * Eagle-style Tags filter: a toolbar chip that opens a popover for building an
 * ad-hoc tag filter. Left-click a tag to include it, right-click to exclude it
 * (the two are mutually exclusive per tag). Counts are faceted — scoped to the
 * current browse context and the *other* active categories, excluding this one.
 */
export function TagFilterControl({
  filters,
  onChange,
  ctx,
}: {
  filters: AdHocFilters
  onChange: (f: AdHocFilters) => void
  ctx: FacetContext
}) {
  const t = filters.tags
  const active = tagFilterActive(t)
  const { open, setOpen, ref, panelRef, pos } = usePopover()

  const badge = t.include.length + t.exclude.length

  return (
    <div className="picker" ref={ref}>
      <button
        className={`filter-chip${active ? ' filter-chip--on' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label="Filter by tags"
      >
        <span className="filter-chip__icon">
          <IconTag />
        </span>
        Tags
        {badge > 0 && <span className="filter-chip__badge">{badge}</span>}
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            className="picker__panel tag-filter"
            ref={panelRef}
            style={{ top: pos.top, bottom: pos.bottom, right: pos.right, maxHeight: pos.maxHeight }}
          >
            <TagFilterPanel filters={filters} onChange={onChange} ctx={ctx} />
          </div>,
          document.body,
        )}
    </div>
  )
}

function TagFilterPanel({
  filters,
  onChange,
  ctx,
}: {
  filters: AdHocFilters
  onChange: (f: AdHocFilters) => void
  ctx: FacetContext
}) {
  const t = filters.tags
  const { data: tags = [] } = useTags()
  const { data: groups = [] } = useTagGroups()
  const { data: memberships = {} } = useTagGroupMemberships()

  const [search, setSearch] = useState('')
  const [groupFilter, setGroupFilter] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const toggleCollapse = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // Facet counts scoped to everything *except* the tags category, so this
  // popover's own include/exclude don't shrink its own numbers.
  const baseFilter = useMemo(
    () =>
      combineFilters(ctx.smartFilter, adHocFiltersToExpression(withoutCategory(filters, 'tags'))),
    [ctx.smartFilter, filters],
  )
  const facets = useFacets({
    view: ctx.view,
    collectionId: ctx.collectionId,
    includeDescendants: ctx.includeDescendants,
    q: ctx.q,
    filter: baseFilter,
    facets: ['tags'],
    // Parent counts follow the active rule: rolled up in Any/All (with subtags
    // on), direct-only in Equal mode.
    tagIncludeDescendants: t.rule !== 'equal' && t.includeDescendants,
  })
  const counts = facets.data?.tags ?? {}

  const inc = new Set(t.include)
  const exc = new Set(t.exclude)

  const setTags = (patch: Partial<typeof t>) => onChange({ ...filters, tags: { ...t, ...patch } })

  const toggleInclude = (id: string) => {
    const include = new Set(t.include)
    const exclude = new Set(t.exclude)
    if (include.has(id)) include.delete(id)
    else {
      include.add(id)
      exclude.delete(id)
    }
    setTags({ include: [...include], exclude: [...exclude] })
  }

  const toggleExclude = (id: string) => {
    const include = new Set(t.include)
    const exclude = new Set(t.exclude)
    if (exclude.has(id)) exclude.delete(id)
    else {
      exclude.add(id)
      include.delete(id)
    }
    setTags({ include: [...include], exclude: [...exclude] })
  }

  // Tags shown as a foldable tree, scoped to a selected group (groups are
  // navigation/display only — they never filter bundles by group). A tag not
  // present in the current view (facet count 0) is hidden unless selected here or
  // an ancestor of a shown tag (so parents stay reachable); counts still loading
  // → show everything. Searching auto-expands so matches never hide in a fold.
  const byId = new Map(tags.map((tg) => [tg.id, tg]))
  const childOf = new Map<string | null, TagRead[]>()
  for (const tg of tags) {
    const k = tg.parent_id ?? null
    childOf.set(k, [...(childOf.get(k) ?? []), tg])
  }
  const groupMember = groupFilter !== null ? new Set(memberships[groupFilter] ?? []) : null
  const match = (tag: TagRead) => !search || tag.name.toLowerCase().includes(search.toLowerCase())
  const countsLoaded = facets.data !== undefined
  const seen = (id: string) => !countsLoaded || (counts[id] ?? 0) > 0 || inc.has(id) || exc.has(id)
  const shown = (id: string): boolean => {
    const tag = byId.get(id)
    return (
      tag !== undefined && (groupMember === null || groupMember.has(id)) && seen(id) && match(tag)
    )
  }
  // Keep a tag if it (or any descendant) is shown, so a hidden/0-count parent
  // still appears as a fold node above its shown children.
  const keepMemo = new Map<string, boolean>()
  const keep = (id: string): boolean => {
    const cached = keepMemo.get(id)
    if (cached !== undefined) return cached
    let k = shown(id)
    for (const c of childOf.get(id) ?? []) if (keep(c.id)) k = true
    keepMemo.set(id, k)
    return k
  }
  const rows = visibleHierarchy(
    tags.filter((tg) => keep(tg.id)),
    search ? new Set() : collapsed,
  )

  return (
    <>
      <div className="tag-filter__head">
        <div className="seg tag-filter__rules" role="group" aria-label="Tag match rule">
          {RULES.map((r) => (
            <button
              key={r.value}
              className={t.rule === r.value ? 'is-active' : ''}
              onClick={() => setTags({ rule: r.value })}
              title={r.title}
              aria-pressed={t.rule === r.value}
            >
              {r.label}
            </button>
          ))}
        </div>
        {t.rule !== 'equal' && (
          <label className="tag-filter__desc" title="Also match descendant (child) tags">
            <input
              type="checkbox"
              checked={t.includeDescendants}
              onChange={(e) => setTags({ includeDescendants: e.target.checked })}
            />
            subtags
          </label>
        )}
      </div>

      <input
        className="edit picker__search"
        placeholder="Search tags…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        aria-label="Search tags"
        autoFocus
      />

      {groups.length > 0 && (
        <div className="pick-filter__chips tag-filter__groups">
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
              onClick={() => setGroupFilter(groupFilter === g.id ? null : g.id)}
            >
              {g.name}
            </button>
          ))}
        </div>
      )}

      {rows.length === 0 && <div className="pick-group">No matching tags</div>}
      {rows.map(({ item, depth, hasChildren }) => {
        const on = inc.has(item.id)
        const off = exc.has(item.id)
        return (
          <div
            key={item.id}
            className={`pick-row tag-filter__row${on ? ' pick-row--on' : ''}${off ? ' tag-filter__row--exc' : ''}`}
            onClick={() => toggleInclude(item.id)}
            onContextMenu={(e) => {
              e.preventDefault()
              toggleExclude(item.id)
            }}
            role="option"
            aria-selected={on}
            title="Left-click to include · right-click to exclude"
          >
            <PickGuides depth={depth} />
            <span
              className={`pick-row__box${on ? ' pick-row__box--on' : ''}${off ? ' pick-row__box--exc' : ''}`}
            >
              {on ? '✓' : off ? '−' : ''}
            </span>
            <span className="pick-row__name">{item.name}</span>
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
      })}

      {tagFilterActive(t) && (
        <div className="tag-filter__foot">
          <span className="tag-filter__hint">Left-click include · right-click exclude</span>
          <button
            className="add-btn"
            onClick={() => setTags({ include: [], exclude: [] })}
            aria-label="Clear tag filter"
          >
            Clear
          </button>
        </div>
      )}
    </>
  )
}

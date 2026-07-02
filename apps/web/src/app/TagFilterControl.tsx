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
import { flattenHierarchy, usePopover } from './usePopover'

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

  // Tags shown: the whole hierarchy, scoped to a selected group (groups are
  // navigation/display only — they never filter bundles by group). A tag that
  // isn't present at all in the current view (facet count 0) is hidden, unless
  // it's already selected here — so a selection never silently disappears. While
  // the counts are still loading, show everything rather than flashing empty.
  const flat = flattenHierarchy(tags)
  const groupMember = groupFilter !== null ? new Set(memberships[groupFilter] ?? []) : null
  const match = (tag: TagRead) => !search || tag.name.toLowerCase().includes(search.toLowerCase())
  const countsLoaded = facets.data !== undefined
  const seen = (id: string) => !countsLoaded || (counts[id] ?? 0) > 0 || inc.has(id) || exc.has(id)
  const rows = flat.filter(
    ({ item }) =>
      (groupMember === null || groupMember.has(item.id)) && match(item) && seen(item.id),
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
      {rows.map(({ item, depth }) => {
        const on = inc.has(item.id)
        const off = exc.has(item.id)
        return (
          <div
            key={item.id}
            className={`pick-row tag-filter__row${on ? ' pick-row--on' : ''}${off ? ' tag-filter__row--exc' : ''}`}
            style={{ paddingLeft: 6 + depth * 14 }}
            onClick={() => toggleInclude(item.id)}
            onContextMenu={(e) => {
              e.preventDefault()
              toggleExclude(item.id)
            }}
            role="option"
            aria-selected={on}
            title="Left-click to include · right-click to exclude"
          >
            <span
              className={`pick-row__box${on ? ' pick-row__box--on' : ''}${off ? ' pick-row__box--exc' : ''}`}
            >
              {on ? '✓' : off ? '−' : ''}
            </span>
            <span className="pick-row__name">{item.name}</span>
            <span className="pick-row__count">{counts[item.id] ?? 0}</span>
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

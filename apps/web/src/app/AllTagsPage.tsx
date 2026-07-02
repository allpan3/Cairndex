import { useMemo, useState } from 'react'

import type { TagRead } from '../api/client'
import {
  useTagCounts,
  useTagGroupMemberships,
  useTagGroups,
  useTagMutations,
  useTags,
} from '../api/hooks'
import { ContextMenu } from './ContextMenu'
import { IconTag } from './icons'
import { alphaBucket, bucketOrder } from './pinyin'
import { useContextMenu } from './useContextMenu'

// Chinese-aware ordering: prefer pinyin collation for zh, fall back to a general
// locale compare. The tree is name-ordered (no manual sort_order).
const collator = new Intl.Collator(['zh-Hans-u-co-pinyin', 'zh', 'en'], {
  numeric: true,
  sensitivity: 'base',
})
const byName = (a: TagRead, b: TagRead): number => collator.compare(a.name, b.name)

const ROOT_DROP = '__root__'

type Panel = 'all' | 'uncategorized' | { groupId: string }

/**
 * The All Tags management surface (Slice 3, accordion-grid redesign). A
 * pinyin-segmented, multi-column grid of top-level tags; a tag with children
 * expands in place to a full-width row listing its children (recursively). Drag
 * a tag onto another to nest it (reparent); drop on empty space to make it
 * top-level — the tree is name-ordered, so there's no manual sibling order.
 * Folded a parent shows its rolled-up subtree count; expanded, its direct count.
 * Double-click a tag to filter; right-click to rename or delete.
 */
export function AllTagsPage({ onApplyTagFilter }: { onApplyTagFilter: (tagId: string) => void }) {
  const { data: tags = [] } = useTags()
  const { data: groups = [] } = useTagGroups()
  const { data: memberships = {} } = useTagGroupMemberships()
  const { data: counts = {} } = useTagCounts()
  const { rename, remove, reparent } = useTagMutations()
  const menu = useContextMenu()

  const [panel, setPanel] = useState<Panel>('all')
  const [search, setSearch] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [dragId, setDragId] = useState<string | null>(null)
  // The prospective drop target while dragging: a tag id (nest under it) or
  // ROOT_DROP (make top-level).
  const [dropId, setDropId] = useState<string | null>(null)

  const byId = useMemo(() => new Map(tags.map((t) => [t.id, t])), [tags])
  const groupedIds = useMemo(() => new Set(Object.values(memberships).flat()), [memberships])
  const uncategorizedCount = useMemo(
    () => tags.filter((t) => !groupedIds.has(t.id)).length,
    [tags, groupedIds],
  )

  const isGroup = typeof panel === 'object'
  const groupId = isGroup ? panel.groupId : null

  // The tags this panel scopes to (All / Uncategorized / a group's members).
  const scopeTags = useMemo(() => {
    if (groupId) {
      const member = new Set(memberships[groupId] ?? [])
      return tags.filter((t) => member.has(t.id))
    }
    if (panel === 'uncategorized') return tags.filter((t) => !groupedIds.has(t.id))
    return tags
  }, [panel, groupId, tags, memberships, groupedIds])

  // A parent that isn't itself in scope makes its children top-level here, so a
  // group/uncategorized subset still renders as a sensible forest.
  const { childrenOf, roots } = useMemo(() => {
    const inScope = new Set(scopeTags.map((t) => t.id))
    const kids = new Map<string, TagRead[]>()
    const rootList: TagRead[] = []
    for (const t of scopeTags) {
      const parent = t.parent_id && inScope.has(t.parent_id) ? t.parent_id : null
      if (parent) kids.set(parent, [...(kids.get(parent) ?? []), t])
      else rootList.push(t)
    }
    for (const list of kids.values()) list.sort(byName)
    rootList.sort(byName)
    return { childrenOf: kids, roots: rootList }
  }, [scopeTags])

  // Rolled-up counts: a folded parent shows the sum of its subtree's direct
  // counts (within scope). Fast client-side aggregate — no extra request.
  const rolledUp = useMemo(() => {
    const memo = new Map<string, number>()
    const calc = (id: string): number => {
      const cached = memo.get(id)
      if (cached !== undefined) return cached
      let sum = counts[id] ?? 0
      for (const c of childrenOf.get(id) ?? []) sum += calc(c.id)
      memo.set(id, sum)
      return sum
    }
    for (const t of scopeTags) calc(t.id)
    return memo
  }, [scopeTags, childrenOf, counts])

  // Section buckets for the top-level tags (pinyin initial / '#' / 'Others').
  const sections = useMemo(() => {
    const map = new Map<string, TagRead[]>()
    for (const r of roots) {
      const b = alphaBucket(r.name)
      map.set(b, [...(map.get(b) ?? []), r])
    }
    return [...map.entries()].sort((a, b) => bucketOrder(a[0]) - bucketOrder(b[0]))
  }, [roots])

  const q = search.trim().toLowerCase()
  const matches = q ? scopeTags.filter((t) => t.name.toLowerCase().includes(q)).sort(byName) : null
  const visibleCount = matches ? matches.length : scopeTags.length

  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // --- Reparent by drag ------------------------------------------------------
  const isAncestor = (ancestorId: string, nodeId: string): boolean => {
    let cur = byId.get(nodeId)?.parent_id ?? null
    while (cur) {
      if (cur === ancestorId) return true
      cur = byId.get(cur)?.parent_id ?? null
    }
    return false
  }
  // Valid to drop `draggedId` onto `targetId` (null = top level): not itself, not
  // already there, and never under its own descendant (no cycles).
  const canDrop = (draggedId: string, targetId: string | null): boolean => {
    if (targetId === draggedId) return false
    const dragged = byId.get(draggedId)
    if (!dragged) return false
    if ((dragged.parent_id ?? null) === (targetId ?? null)) return false
    if (targetId !== null && isAncestor(draggedId, targetId)) return false
    return true
  }
  const endDrag = () => {
    setDragId(null)
    setDropId(null)
  }
  const doReparent = (targetId: string | null) => {
    const id = dragId
    endDrag()
    if (id === null || !canDrop(id, targetId)) return
    reparent.mutate({ id, parentId: targetId, version: byId.get(id)?.version })
  }

  const startDelete = (tag: TagRead) => {
    // First-version safe delete: block a parent with children with a friendly
    // message (matches the server guard) rather than cascading.
    if ((childrenOf.get(tag.id)?.length ?? 0) > 0 || tags.some((t) => t.parent_id === tag.id)) {
      window.alert(
        `“${tag.name}” has child tags. Move or delete its child tags first, then delete it.`,
      )
      return
    }
    if (!window.confirm(`Delete tag “${tag.name}”? This removes it from all bundles.`)) return
    remove.mutate(tag.id, {
      onError: (err) => window.alert(err instanceof Error ? err.message : 'Could not delete tag'),
    })
  }

  const openMenu = (tag: TagRead, e: React.MouseEvent) => {
    e.preventDefault()
    menu.open(e, [
      { label: 'Rename Tag', onClick: () => setRenamingId(tag.id) },
      null,
      { label: 'Delete Tag', danger: true, onClick: () => startDelete(tag) },
    ])
  }

  // --- Tile rendering (recursive) -------------------------------------------
  const renderTile = (tag: TagRead, flat = false): React.ReactElement => {
    const kids = childrenOf.get(tag.id) ?? []
    const hasKids = !flat && kids.length > 0
    const open = hasKids && expanded.has(tag.id)
    const count = open ? (counts[tag.id] ?? 0) : (rolledUp.get(tag.id) ?? 0)
    return (
      <div
        key={tag.id}
        className={`tagtile${open ? ' tagtile--open' : ''}${dropId === tag.id ? ' tagtile--drop' : ''}${
          dragId === tag.id ? ' tagtile--dragging' : ''
        }`}
        draggable={renamingId !== tag.id}
        onDragStart={(e) => {
          e.stopPropagation()
          setDragId(tag.id)
        }}
        onDragEnd={endDrag}
        onDragOver={(e) => {
          if (dragId === null || !canDrop(dragId, tag.id)) return
          e.preventDefault()
          e.stopPropagation()
          if (dropId !== tag.id) setDropId(tag.id)
        }}
        onDrop={(e) => {
          e.stopPropagation()
          doReparent(tag.id)
        }}
      >
        <div
          className="tagtile__head"
          onDoubleClick={() => onApplyTagFilter(tag.id)}
          onContextMenu={(e) => openMenu(tag, e)}
          title="Double-click to filter · right-click to rename or delete · drag onto a tag to nest it"
        >
          {hasKids ? (
            <button
              className="tagtile__chevron"
              onClick={() => toggleExpand(tag.id)}
              aria-label={open ? 'Collapse' : 'Expand'}
            >
              {open ? '▾' : '▸'}
            </button>
          ) : (
            <span className="tagtile__chevron tagtile__chevron--leaf" aria-hidden />
          )}
          {renamingId === tag.id ? (
            <TagRenameInput
              tag={tag}
              onCommit={(name) => {
                if (name && name !== tag.name)
                  rename.mutate({ id: tag.id, name, version: tag.version })
                setRenamingId(null)
              }}
              onCancel={() => setRenamingId(null)}
            />
          ) : (
            <>
              <span className="tagtile__name">{tag.name}</span>
              <span className="tagtile__count">{count}</span>
            </>
          )}
        </div>
        {open && <div className="tagtile__children">{kids.map((k) => renderTile(k))}</div>}
      </div>
    )
  }

  return (
    <div className="alltags">
      <div className="alltags__side">
        <button
          className={`alltags__nav${panel === 'all' ? ' is-active' : ''}`}
          onClick={() => setPanel('all')}
        >
          <IconTag />
          <span className="alltags__nav-label">All</span>
          <span className="alltags__nav-count">{tags.length}</span>
        </button>
        <button
          className={`alltags__nav${panel === 'uncategorized' ? ' is-active' : ''}`}
          onClick={() => setPanel('uncategorized')}
        >
          <span className="alltags__nav-label">Uncategorized</span>
          <span className="alltags__nav-count">{uncategorizedCount}</span>
        </button>
        {groups.length > 0 && <div className="alltags__side-head">Tag Groups</div>}
        {groups.map((g) => (
          <button
            key={g.id}
            className={`alltags__nav${groupId === g.id ? ' is-active' : ''}`}
            onClick={() => setPanel({ groupId: g.id })}
          >
            <span className="alltags__nav-label">{g.name}</span>
            <span className="alltags__nav-count">{memberships[g.id]?.length ?? 0}</span>
          </button>
        ))}
      </div>

      <div className="alltags__main">
        <div className="alltags__toolbar">
          <span className="alltags__title">
            {panel === 'all'
              ? 'All'
              : panel === 'uncategorized'
                ? 'Uncategorized'
                : (groups.find((g) => g.id === groupId)?.name ?? 'Group')}
          </span>
          <span className="alltags__count">{visibleCount} tags</span>
          <span className="toolbar__spacer" />
          <input
            type="search"
            className="edit"
            placeholder="Search tags…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search tags"
          />
        </div>

        {/* Dropping on empty space (not on a tile) makes the dragged tag top-level. */}
        <div
          className={`alltags__grid-scroll${dropId === ROOT_DROP ? ' alltags__grid-scroll--root' : ''}`}
          onDragOver={(e) => {
            if (dragId === null || !canDrop(dragId, null)) return
            e.preventDefault()
            if (dropId !== ROOT_DROP) setDropId(ROOT_DROP)
          }}
          onDrop={() => doReparent(null)}
        >
          {visibleCount === 0 && (
            <div className="state">
              {tags.length === 0 ? 'No tags yet.' : 'No tags match this filter.'}
            </div>
          )}

          {matches ? (
            <section className="tagsec">
              <div className="tagsec__head">
                Results <span className="tagsec__count">{matches.length}</span>
              </div>
              <div className="tagsec__grid">{matches.map((t) => renderTile(t, true))}</div>
            </section>
          ) : (
            sections.map(([letter, sectionRoots]) => (
              <section className="tagsec" key={letter}>
                <div className="tagsec__head">
                  {letter} <span className="tagsec__count">{sectionRoots.length}</span>
                </div>
                <div className="tagsec__grid">{sectionRoots.map((t) => renderTile(t))}</div>
              </section>
            ))
          )}
        </div>
      </div>

      <ContextMenu state={menu.state} onClose={menu.close} />
    </div>
  )
}

function TagRenameInput({
  tag,
  onCommit,
  onCancel,
}: {
  tag: TagRead
  onCommit: (name: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(tag.name)
  return (
    <input
      className="edit edit--inline tagtile__rename"
      value={value}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onCommit(value.trim())}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          e.currentTarget.blur()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          onCancel()
        }
      }}
      aria-label={`Rename ${tag.name}`}
    />
  )
}

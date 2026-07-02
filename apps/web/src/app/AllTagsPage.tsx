import { useLayoutEffect, useMemo, useRef, useState } from 'react'

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
import { type DropPosition, planReorder, siblingKeyOf } from './tagReorder'
import { useContextMenu } from './useContextMenu'

// Chinese-aware ordering: prefer pinyin collation for zh, fall back to a general
// locale compare. Explicit sort_order wins; name is only the tiebreaker.
const collator = new Intl.Collator(['zh-Hans-u-co-pinyin', 'zh', 'en'], {
  numeric: true,
  sensitivity: 'base',
})
const byOrderThenName = (a: TagRead, b: TagRead): number =>
  a.sort_order - b.sort_order || collator.compare(a.name, b.name)

interface Row {
  tag: TagRead
  depth: number
  // The sibling group key this row belongs to (parent id, or null at the root).
  // Reorder is constrained to a single sibling group.
  parentKey: string | null
}

/** Depth-first forest over the given tags, treating a parent that isn't in the
 * set as a root so a filtered subset still renders sensibly. */
function buildForest(tags: TagRead[]): Row[] {
  const ids = new Set(tags.map((t) => t.id))
  const byParent = new Map<string | null, TagRead[]>()
  for (const t of tags) {
    const key = t.parent_id && ids.has(t.parent_id) ? t.parent_id : null
    byParent.set(key, [...(byParent.get(key) ?? []), t])
  }
  const out: Row[] = []
  const walk = (parent: string | null, depth: number) => {
    for (const t of (byParent.get(parent) ?? []).slice().sort(byOrderThenName)) {
      out.push({ tag: t, depth, parentKey: parent })
      walk(t.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}

// A big structural move (e.g. reordering whole subtrees) shifts hundreds of
// rows; animating them all is janky and pointless. Above this many moved rows we
// just snap.
const FLIP_MAX_ROWS = 80

// FLIP animation: when `signature` (the visible row order) changes but the *set*
// of rows is the same — i.e. a reorder, not a filter/panel switch — slide each
// moved row from its previous position to its new one. Runs only on order change
// (keyed on `signature`), so hovering/dropline updates don't thrash layout. Uses
// the Web Animations API so each row cleans itself up (no lingering inline
// transform even if a frame is dropped) — a plain rAF-based FLIP can leave rows
// stuck offset when rAF is throttled (e.g. a backgrounded tab).
function useReorderFlip(signature: string) {
  const listRef = useRef<HTMLDivElement>(null)
  const prev = useRef<{ ids: Set<string>; pos: Map<string, number> }>({
    ids: new Set(),
    pos: new Map(),
  })

  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    const rows = [...el.querySelectorAll<HTMLElement>('[data-flip-id]')]
    const pos = new Map<string, number>()
    for (const r of rows) pos.set(r.dataset.flipId as string, r.offsetTop)
    const ids = new Set(pos.keys())

    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const sameSet =
      ids.size === prev.current.ids.size && [...ids].every((id) => prev.current.ids.has(id))
    if (!reduce && sameSet && prev.current.pos.size && typeof rows[0]?.animate === 'function') {
      const moved: [HTMLElement, number][] = []
      for (const r of rows) {
        const dy =
          (prev.current.pos.get(r.dataset.flipId as string) ?? 0) -
          (pos.get(r.dataset.flipId as string) ?? 0)
        if (dy) moved.push([r, dy])
      }
      if (moved.length && moved.length <= FLIP_MAX_ROWS) {
        for (const [r, dy] of moved) {
          r.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], {
            duration: 200,
            easing: 'cubic-bezier(0.2, 0, 0, 1)',
          })
        }
      }
    }
    prev.current = { ids, pos }
  }, [signature])

  return listRef
}

type Panel = 'all' | 'uncategorized' | { groupId: string }

/**
 * The All Tags management surface (Slice 3). Not a bundle collection and not a
 * filesystem folder — it renames, deletes, and reorders tags. Left panel scopes
 * which tags show (All / Uncategorized / a group, display-only); the main panel
 * is a searchable, drag-reorderable hierarchy with counts. Double-clicking a tag
 * navigates to All with a global Equal/direct tag filter applied.
 */
export function AllTagsPage({ onApplyTagFilter }: { onApplyTagFilter: (tagId: string) => void }) {
  const { data: tags = [] } = useTags()
  const { data: groups = [] } = useTagGroups()
  const { data: memberships = {} } = useTagGroupMemberships()
  const { data: counts = {} } = useTagCounts()
  const { rename, remove, reorder, reorderInGroup } = useTagMutations()
  const menu = useContextMenu()

  const [panel, setPanel] = useState<Panel>('all')
  const [search, setSearch] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  // Where a valid drop would land, so we can draw an insertion line at that spot.
  const [dropHint, setDropHint] = useState<{ targetId: string; position: DropPosition } | null>(
    null,
  )

  const byId = useMemo(() => new Map(tags.map((t) => [t.id, t])), [tags])
  const groupedIds = useMemo(() => new Set(Object.values(memberships).flat()), [memberships])
  const childrenCount = useMemo(() => {
    const map = new Map<string, number>()
    for (const t of tags) if (t.parent_id) map.set(t.parent_id, (map.get(t.parent_id) ?? 0) + 1)
    return map
  }, [tags])

  const isGroup = typeof panel === 'object'
  const groupId = isGroup ? panel.groupId : null

  // Rows for the main panel. A group renders as a flat list in membership order;
  // All / Uncategorized render as a hierarchy.
  const rows: Row[] = useMemo(() => {
    if (groupId) {
      const ordered = memberships[groupId] ?? []
      return ordered
        .map((id) => byId.get(id))
        .filter((t): t is TagRead => t !== undefined)
        .map((tag) => ({ tag, depth: 0, parentKey: `group:${groupId}` }))
    }
    const scope = panel === 'uncategorized' ? tags.filter((t) => !groupedIds.has(t.id)) : tags
    return buildForest(scope)
  }, [panel, groupId, tags, byId, memberships, groupedIds])

  const q = search.trim().toLowerCase()
  const visible = q ? rows.filter((r) => r.tag.name.toLowerCase().includes(q)) : rows

  // Slide rows to their new spots after a reorder (FLIP), keyed on the row order.
  const flipRef = useReorderFlip(visible.map((r) => r.tag.id).join(','))

  const startDelete = (tag: TagRead) => {
    // First-version safe delete: block a parent with children with a friendly
    // message (matches the server guard) rather than cascading.
    if ((childrenCount.get(tag.id) ?? 0) > 0) {
      window.alert(
        `“${tag.name}” has child tags. Delete or move its child tags first, then delete it.`,
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

  const parentOf = (tid: string) => byId.get(tid)?.parent_id ?? null
  const hasTag = (tid: string) => byId.has(tid)

  // True when dragging the current `dragId` onto `row` is a valid sibling drop
  // (same sibling group; never reparent). Drives whether we allow the drop and
  // show the insertion line.
  const isValidTarget = (row: Row): boolean =>
    dragId !== null &&
    dragId !== row.tag.id &&
    siblingKeyOf(dragId, groupId, parentOf, hasTag) === row.parentKey

  const endDrag = () => {
    setDragId(null)
    setDropHint(null)
  }

  const onDrop = (target: Row) => {
    const id = dragId
    const position = dropHint?.targetId === target.tag.id ? dropHint.position : 'before'
    endDrag()
    if (id === null) return
    const plan = planReorder({
      dragId: id,
      target,
      position,
      groupId,
      parentOf,
      hasTag,
      siblingIds: rows.filter((r) => r.parentKey === target.parentKey).map((r) => r.tag.id),
      groupOrder: groupId ? (memberships[groupId] ?? []) : [],
    })
    if (plan === null) return
    if (plan.kind === 'group')
      reorderInGroup.mutate({ groupId: plan.groupId, orderedIds: plan.orderedIds })
    else reorder.mutate({ parentId: plan.parentId, orderedIds: plan.orderedIds })
  }

  return (
    <div className="alltags">
      <div className="alltags__side">
        <button
          className={`alltags__nav${panel === 'all' ? ' is-active' : ''}`}
          onClick={() => setPanel('all')}
        >
          <IconTag /> All Tags
        </button>
        <button
          className={`alltags__nav${panel === 'uncategorized' ? ' is-active' : ''}`}
          onClick={() => setPanel('uncategorized')}
        >
          Uncategorized
        </button>
        {groups.length > 0 && <div className="alltags__side-head">Tag Groups</div>}
        {groups.map((g) => (
          <button
            key={g.id}
            className={`alltags__nav${groupId === g.id ? ' is-active' : ''}`}
            onClick={() => setPanel({ groupId: g.id })}
          >
            {g.name}
          </button>
        ))}
      </div>

      <div className="alltags__main">
        <div className="alltags__toolbar">
          <span className="alltags__title">
            {panel === 'all'
              ? 'All Tags'
              : panel === 'uncategorized'
                ? 'Uncategorized'
                : (groups.find((g) => g.id === groupId)?.name ?? 'Group')}
          </span>
          <span className="alltags__count">{visible.length} tags</span>
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

        <div className="alltags__list" ref={flipRef}>
          {visible.length === 0 && (
            <div className="state">
              {tags.length === 0 ? 'No tags yet.' : 'No tags match this filter.'}
            </div>
          )}
          {visible.map((row) => {
            const t = row.tag
            const dragging = dragId === t.id
            const canReorder = !q // dragging while searching would reorder a filtered subset
            const indent = 10 + row.depth * 16
            const hinted = dropHint?.targetId === t.id ? dropHint.position : null
            return (
              <div
                key={t.id}
                data-flip-id={t.id}
                className={`alltags__row${dragging ? ' alltags__row--dragging' : ''}${
                  hinted ? ` alltags__row--drop-${hinted}` : ''
                }`}
                style={
                  { paddingLeft: indent, ['--drop-indent']: `${indent}px` } as React.CSSProperties
                }
                draggable={canReorder && renamingId !== t.id}
                onDragStart={() => setDragId(t.id)}
                onDragEnd={endDrag}
                onDragOver={(e) => {
                  // Only a valid sibling target accepts the drop (no reparenting).
                  // Pick before/after from which half of the row the cursor is over,
                  // so the insertion line shows exactly where the tag will land.
                  if (!canReorder || !isValidTarget(row)) return
                  e.preventDefault()
                  const rect = e.currentTarget.getBoundingClientRect()
                  const position: DropPosition =
                    e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
                  if (dropHint?.targetId !== t.id || dropHint.position !== position)
                    setDropHint({ targetId: t.id, position })
                }}
                onDrop={() => onDrop(row)}
                onDoubleClick={() => onApplyTagFilter(t.id)}
                onContextMenu={(e) => openMenu(t, e)}
                role="treeitem"
                title="Double-click to filter · right-click to rename or delete"
              >
                <span className="alltags__grip" aria-hidden>
                  ⠿
                </span>
                {renamingId === t.id ? (
                  <TagRenameInput
                    tag={t}
                    onCommit={(name) => {
                      if (name && name !== t.name)
                        rename.mutate({ id: t.id, name, version: t.version })
                      setRenamingId(null)
                    }}
                    onCancel={() => setRenamingId(null)}
                  />
                ) : (
                  <>
                    <span className="alltags__name">{t.name}</span>
                    <span className="alltags__row-count">{counts[t.id] ?? 0}</span>
                  </>
                )}
              </div>
            )
          })}
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
      className="edit edit--inline alltags__rename"
      value={value}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onCommit(value.trim())}
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

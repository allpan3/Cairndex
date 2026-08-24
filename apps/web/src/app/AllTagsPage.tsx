import { useMemo, useState } from 'react'

import { fetchTagDeleteImpact, type TagGroupRead, type TagRead } from '../api/client'
import {
  useCreateTagPath,
  useTagCounts,
  useTagGroupMemberships,
  useTagGroupMutations,
  useTagGroups,
  useTagMutations,
  useTags,
} from '../api/hooks'
import { ConfirmDialog, PromptDialog } from './PromptDialog'
import { ContextMenu } from './ContextMenu'
import { IconPlus } from './icons'
import { alphaBucket, bucketOrder, usePinyinSearch } from './pinyin'
import type { MenuEntry } from './useContextMenu'
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
 * Double-click a tag to filter; right-click for the rest.
 *
 * It is also where tags and tag groups are *made*, not just tidied: the toolbar
 * creates a top-level tag and expands/collapses the whole tree, the side rail
 * creates, renames and deletes groups, and a tag joins or leaves a group from
 * its context menu or by being dragged onto a group row. Until this existed the
 * only way to make a tag was to type one into a bundle's tag picker, and there
 * was no way at all to make a group or put a tag in one (owner, 2026-08-23).
 */
export function AllTagsPage({ onApplyTagFilter }: { onApplyTagFilter: (tagId: string) => void }) {
  const { data: tags = [] } = useTags()
  const { data: groups = [] } = useTagGroups()
  const { data: memberships = {} } = useTagGroupMemberships()
  const { data: counts = {} } = useTagCounts()
  const { rename, remove, reparent } = useTagMutations()
  const groupMutations = useTagGroupMutations()
  const createTagPath = useCreateTagPath()
  // The tag awaiting a delete confirmation, with what the delete would take.
  // The tag awaiting confirmation. `children`/`bundles` are null when the impact
  // lookup failed: the prompt then asks without claiming a cost it does not know.
  const [deleting, setDeleting] = useState<{
    tag: TagRead
    children: number | null
    bundles: number | null
  } | null>(null)
  // A failed write, shown as an acknowledge-only dialog. Carries its own title
  // because several different operations report through it.
  const [error, setError] = useState<{ title: string; body: string } | null>(null)
  const menu = useContextMenu()

  const [panel, setPanel] = useState<Panel>('all')
  const [search, setSearch] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [dragId, setDragId] = useState<string | null>(null)
  // The prospective drop target while dragging: a tag id (nest under it) or
  // ROOT_DROP (make top-level).
  const [dropId, setDropId] = useState<string | null>(null)
  // The group row a dragged tag is over — dropping there adds it to that group,
  // which is group membership, not nesting: the tag keeps its parent.
  const [dropGroupId, setDropGroupId] = useState<string | null>(null)
  // Pending prompts. `creatingTag.parent` null means a top-level tag.
  const [creatingTag, setCreatingTag] = useState<{ parent: TagRead | null } | null>(null)
  const [creatingGroup, setCreatingGroup] = useState(false)
  const [renamingGroup, setRenamingGroup] = useState<TagGroupRead | null>(null)
  const [deletingGroup, setDeletingGroup] = useState<TagGroupRead | null>(null)

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

  const q = search.trim()
  const matchSearch = usePinyinSearch(q)
  const matches = q ? scopeTags.filter((t) => matchSearch(t.name)).sort(byName) : null
  const visibleCount = matches ? matches.length : scopeTags.length

  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // Every tag that has children *in this scope* — the set "Expand all" opens.
  // Scoped, so expanding inside a group doesn't also unfold branches the panel
  // isn't showing, and one toggle can report whether the tree is fully open.
  const parentIds = useMemo(() => [...childrenOf.keys()], [childrenOf])
  const allExpanded = parentIds.length > 0 && parentIds.every((id) => expanded.has(id))

  // --- Creating tags and groups ---------------------------------------------
  // `/` nests, so "Studio/Series" makes both in one go; beneath a parent it
  // nests from there. A tag made while a group panel is open joins that group —
  // otherwise "new tag" in a group would create something the panel cannot show.
  const submitNewTag = (path: string) => {
    const parent = creatingTag?.parent ?? null
    setCreatingTag(null)
    createTagPath.mutate(
      { path, existing: tags, parentId: parent?.id ?? null },
      {
        onSuccess: (tag) => {
          if (parent) setExpanded((prev) => new Set(prev).add(parent.id))
          if (groupId) groupMutations.addTag.mutate({ groupId, tagId: tag.id })
        },
        onError: (err) =>
          setError({
            title: 'Could not create tag',
            body: err instanceof Error ? err.message : 'The tag was not created.',
          }),
      },
    )
  }

  const submitNewGroup = (name: string) => {
    setCreatingGroup(false)
    groupMutations.create.mutate(name, {
      onSuccess: (group) => setPanel({ groupId: group.id }),
      onError: (err) =>
        setError({
          title: 'Could not create tag group',
          body: err instanceof Error ? err.message : 'The group was not created.',
        }),
    })
  }

  const submitGroupRename = (name: string) => {
    const group = renamingGroup
    setRenamingGroup(null)
    if (!group || name === group.name) return
    groupMutations.rename.mutate(
      { id: group.id, name },
      {
        onError: (err) =>
          setError({
            title: 'Could not rename tag group',
            body: err instanceof Error ? err.message : 'The group was not renamed.',
          }),
      },
    )
  }

  const confirmGroupDelete = () => {
    const group = deletingGroup
    if (!group) return
    groupMutations.remove.mutate(group.id, {
      onSuccess: () => {
        setDeletingGroup(null)
        // The panel showing the group it just deleted has nothing left to scope
        // to, so fall back to All rather than render an empty unnamed panel.
        setPanel((cur) => (typeof cur === 'object' && cur.groupId === group.id ? 'all' : cur))
      },
      onError: (err) => {
        setDeletingGroup(null)
        setError({
          title: 'Could not delete tag group',
          body: err instanceof Error ? err.message : 'The group was not deleted.',
        })
      },
    })
  }

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
    setDropGroupId(null)
  }
  // Dropping a tag on a group row adds it to that group. Refused when it is
  // already a member, so the row gives no drop cue for a no-op.
  const canJoinGroup = (id: string | null, group: string): boolean =>
    id !== null && !(memberships[group] ?? []).includes(id)
  const doJoinGroup = (group: string) => {
    const id = dragId
    endDrag()
    if (!canJoinGroup(id, group)) return
    groupMutations.addTag.mutate(
      { groupId: group, tagId: id as string },
      {
        onError: (err) =>
          setError({
            title: 'Could not add the tag to that group',
            body: err instanceof Error ? err.message : 'Group membership is unchanged.',
          }),
      },
    )
  }
  const doReparent = (targetId: string | null) => {
    const id = dragId
    endDrag()
    if (id === null || !canDrop(id, targetId)) return
    reparent.mutate({ id, parentId: targetId, version: byId.get(id)?.version })
  }

  // Deleting a parent used to be refused outright, which read as broken rather
  // than guarded (owner, 2026-07-27). It is allowed now, but only after saying
  // what it takes: how many tags, and how many bundles lose a tag. The counts
  // come from the server so the prompt cannot understate a subtree the page has
  // not loaded.
  // Asking happens in a rendered dialog, not `window.confirm`: the desktop
  // webview does not implement it, so the whole prompt was silently skipped
  // there (owner, 2026-07-27).
  const startDelete = (tag: TagRead) => {
    void (async () => {
      let impact: { tags: number; bundles: number } | null = null
      try {
        impact = await fetchTagDeleteImpact(tag.id)
      } catch {
        // Left null deliberately. Not knowing the cost is a reason to ask, not a
        // reason to skip asking — treating a failed lookup as "nothing to warn
        // about" would make a destructive action *less* guarded exactly when the
        // server is least trustworthy.
      }
      // Skip the prompt only when the server has positively said there is
      // nothing to lose: no children, and no bundle carrying the tag.
      if (impact !== null && impact.tags === 1 && impact.bundles === 0) {
        remove.mutate(
          { id: tag.id },
          {
            onError: (err) =>
              setError({
                title: 'Could not delete tag',
                body: err instanceof Error ? err.message : 'The tag was not deleted.',
              }),
          },
        )
        return
      }
      setDeleting({
        tag,
        children: impact ? impact.tags - 1 : null,
        bundles: impact?.bundles ?? null,
      })
    })()
  }

  const confirmDelete = () => {
    if (!deleting) return
    const { tag, children } = deleting
    remove.mutate(
      // Unknown child count cascades: the user has confirmed, and refusing here
      // would resurrect the "deleting a parent does nothing" bug.
      { id: tag.id, cascade: children === null || children > 0 },
      {
        onSuccess: () => setDeleting(null),
        onError: (err) => {
          setDeleting(null)
          setError({
            title: 'Could not delete tag',
            body: err instanceof Error ? err.message : 'The tag was not deleted.',
          })
        },
      },
    )
  }

  const openMenu = (tag: TagRead, e: React.MouseEvent) => {
    e.preventDefault()
    // One row per group rather than a submenu: this menu has no nesting, and a
    // membership that reads "Remove from X" when it is already a member says
    // which way the toggle goes without a checkmark column.
    const groupRows: MenuEntry[] = groups.map((g) =>
      (memberships[g.id] ?? []).includes(tag.id)
        ? {
            label: `Remove from ${g.name}`,
            onClick: () => groupMutations.removeTag.mutate({ groupId: g.id, tagId: tag.id }),
          }
        : {
            label: `Add to ${g.name}`,
            onClick: () => groupMutations.addTag.mutate({ groupId: g.id, tagId: tag.id }),
          },
    )
    menu.open(e, [
      { label: 'New Child Tag', onClick: () => setCreatingTag({ parent: tag }) },
      { label: 'Rename Tag', onClick: () => setRenamingId(tag.id) },
      ...(groupRows.length > 0 ? [null, ...groupRows] : []),
      null,
      { label: 'Delete Tag', danger: true, onClick: () => startDelete(tag) },
    ])
  }

  const openGroupMenu = (group: TagGroupRead, e: React.MouseEvent) => {
    e.preventDefault()
    menu.open(e, [
      { label: 'Rename Group', onClick: () => setRenamingGroup(group) },
      null,
      // Metadata-only: a group is a view over tags, so deleting it takes the
      // memberships and nothing else. Said plainly in the prompt below.
      { label: 'Delete Group', danger: true, onClick: () => setDeletingGroup(group) },
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
              {open ? '⌄' : '›'}
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
        {/* Always shown, groups or not: with no groups yet this header and its
            "+" are the only thing that says groups exist at all. */}
        <div className="alltags__side-head">
          <span>Tag Groups</span>
          <button
            className="alltags__side-add"
            onClick={() => setCreatingGroup(true)}
            aria-label="New tag group"
            title="New tag group"
          >
            <IconPlus />
          </button>
        </div>
        {groups.length === 0 && <div className="alltags__side-hint">No groups yet.</div>}
        {groups.map((g) => (
          <button
            key={g.id}
            className={`alltags__nav${groupId === g.id ? ' is-active' : ''}${
              dropGroupId === g.id ? ' alltags__nav--drop' : ''
            }`}
            onClick={() => setPanel({ groupId: g.id })}
            onContextMenu={(e) => openGroupMenu(g, e)}
            title="Right-click to rename or delete · drag a tag here to add it"
            onDragOver={(e) => {
              if (!canJoinGroup(dragId, g.id)) return
              e.preventDefault()
              e.stopPropagation()
              if (dropGroupId !== g.id) setDropGroupId(g.id)
            }}
            onDragLeave={() => setDropGroupId((cur) => (cur === g.id ? null : cur))}
            onDrop={(e) => {
              e.preventDefault()
              e.stopPropagation()
              doJoinGroup(g.id)
            }}
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
          <span className="alltags__count">
            {visibleCount} {visibleCount === 1 ? 'tag' : 'tags'}
          </span>
          <span className="toolbar__spacer" />
          {/* Meaningless over a flat search-result list, which has no folds. */}
          {matches === null && (
            <button
              className="btn btn--compact"
              onClick={() => setExpanded(allExpanded ? new Set() : new Set(parentIds))}
              disabled={parentIds.length === 0}
              title={
                parentIds.length === 0
                  ? 'No tag here has children'
                  : allExpanded
                    ? 'Collapse every tag with children'
                    : 'Expand every tag with children'
              }
            >
              {allExpanded ? 'Collapse all' : 'Expand all'}
            </button>
          )}
          <button
            className="btn btn--compact"
            onClick={() => setCreatingTag({ parent: null })}
            title={
              groupId
                ? 'Create a tag and add it to this group'
                : 'Create a tag — use / to nest, e.g. Studio/Series'
            }
          >
            New Tag
          </button>
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
              {tags.length === 0
                ? 'No tags yet. Use “New Tag” to make one.'
                : 'No tags match this filter.'}
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

      {deleting && (
        <ConfirmDialog
          title={
            deleting.children !== null && deleting.children > 0
              ? 'Delete Tag and Its Children'
              : 'Delete Tag'
          }
          pending={remove.isPending}
          onCancel={() => setDeleting(null)}
          onConfirm={confirmDelete}
          body={
            <>
              Delete “{deleting.tag.name}”?
              {deleting.children === null && (
                <> Its child tags and any bundles carrying it are affected too.</>
              )}
              {deleting.children !== null && deleting.children > 0 && (
                <>
                  {' '}
                  This also deletes {deleting.children} child tag
                  {deleting.children === 1 ? '' : 's'}.
                </>
              )}
              {deleting.bundles !== null && deleting.bundles > 0 && (
                <>
                  {' '}
                  {deleting.bundles} bundle{deleting.bundles === 1 ? '' : 's'} will lose the tag. No
                  files are touched.
                </>
              )}
            </>
          }
        />
      )}

      {creatingTag !== null && (
        <PromptDialog
          title={creatingTag.parent ? `New Tag in “${creatingTag.parent.name}”` : 'New Tag'}
          label={
            creatingTag.parent
              ? `Name — use / to nest further under “${creatingTag.parent.name}”`
              : 'Name — use / to nest, e.g. Studio/Series'
          }
          confirmLabel="Create"
          onCancel={() => setCreatingTag(null)}
          onConfirm={submitNewTag}
        />
      )}

      {creatingGroup && (
        <PromptDialog
          title="New Tag Group"
          label="Name"
          confirmLabel="Create"
          onCancel={() => setCreatingGroup(false)}
          onConfirm={submitNewGroup}
        />
      )}

      {renamingGroup !== null && (
        <PromptDialog
          title="Rename Tag Group"
          label="Name"
          initial={renamingGroup.name}
          onCancel={() => setRenamingGroup(null)}
          onConfirm={submitGroupRename}
        />
      )}

      {deletingGroup !== null && (
        <ConfirmDialog
          title="Delete Tag Group"
          pending={groupMutations.remove.isPending}
          onCancel={() => setDeletingGroup(null)}
          onConfirm={confirmGroupDelete}
          body={
            <>
              Delete the group “{deletingGroup.name}”?{' '}
              {(memberships[deletingGroup.id]?.length ?? 0) === 1
                ? 'Its one tag stays'
                : `Its ${memberships[deletingGroup.id]?.length ?? 0} tags stay`}{' '}
              — only the grouping is removed.
            </>
          }
        />
      )}

      {error !== null && (
        <ConfirmDialog
          title={error.title}
          body={error.body}
          confirmLabel="OK"
          danger={false}
          onCancel={() => setError(null)}
          onConfirm={() => setError(null)}
        />
      )}
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

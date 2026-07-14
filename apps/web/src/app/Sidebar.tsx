import { Fragment, useEffect, useMemo, useRef, useState } from 'react'

import type {
  CollectionRead,
  JobRead,
  LibraryRead,
  SmartCollectionRead,
  ViewCounts,
} from '../api/client'
import { ContextMenu } from './ContextMenu'
import { JobProgress } from './JobProgress'
import { type MenuEntry, useContextMenu } from './useContextMenu'
import {
  IconAlert,
  IconChevron,
  IconClock,
  IconFilter,
  IconFolder,
  IconFolderQuestion,
  IconGrid,
  IconLooseStack,
  IconSettings,
  IconTag,
  IconTagQuestion,
} from './icons'
import type { DragItem } from './dnd'
import { dropZone } from './dnd'
import { PickGuides } from './PickGuides'
import { moveTo } from './reorder'
import { SYSTEM_VIEWS, type AppMode, type Selection } from './types'
import { usePersistentState } from '../state/usePersistentState'

import type { SystemView } from '../api/client'
import type { ReactNode } from 'react'

/** Inline-SVG icon for each system view (replaces the emoji glyphs). */
function viewIcon(view: SystemView): ReactNode {
  switch (view) {
    case 'all':
      return <IconGrid />
    case 'recent':
      return <IconClock />
    case 'uncategorized':
      return <IconFolderQuestion />
    case 'untagged':
      return <IconTagQuestion />
    case 'missing':
      return <IconAlert />
    case 'unbundled':
      return <IconLooseStack />
  }
}

interface SidebarProps {
  mode: AppMode
  onMode: (mode: AppMode) => void
  libraries: LibraryRead[]
  libraryId: string | null
  onChangeLibrary: (libraryId: string) => void
  onManageLibraries: () => void
  onOpenSettings: () => void
  canLock?: boolean
  onLock?: () => void
  onUpdateLibrary: () => void
  updating?: boolean
  onScanFiles: () => void
  scanningFiles?: boolean
  onProbe: () => void
  probing?: boolean
  onGenerateStoryboards: () => void
  generatingStoryboards?: boolean
  onReviewGrouping: () => void
  activeJob?: JobRead | null
  maintenanceError?: string | null
  selection: Selection
  onSelect: (selection: Selection) => void
  // Unbundled is a Files-surface view (a flat "to-bundle queue"), so it routes
  // into Files mode rather than selecting a bundle browse view.
  onOpenUnbundled?: () => void
  // All Tags is a management surface (mode='tags'), not a bundle browse view.
  onOpenAllTags?: () => void
  fileScope?: 'browse' | 'unbundled'
  counts?: ViewCounts
  collections: CollectionRead[]
  collectionCounts?: Record<string, number>
  onDeleteCollection: (collection: CollectionRead) => void
  onCreateCollection: (
    payload: { name: string; parent_id: string | null },
    callbacks: { onSuccess: (created: CollectionRead) => void; onError: (err: unknown) => void },
  ) => void
  onRenameCollection: (
    id: string,
    name: string,
    callbacks: { onSuccess: () => void; onError: (err: unknown) => void },
  ) => void
  // Persist a manual drag-reorder of one sibling group (parentId null = top level).
  onReorderCollections: (parentId: string | null, orderedIds: string[]) => void
  // Move a collection into a different parent group at a specific slot (reparent
  // + reorder). newParentId null = the top level.
  onMoveCollection?: (id: string, newParentId: string | null, orderedIds: string[]) => void
  // Right-click the Collections heading → clean up the collection manual order.
  onCleanupCollections?: () => void
  // Cross-surface drag: the current payload + callbacks to reparent a collection
  // or move bundles into a collection by dropping on a sidebar row.
  dragItem?: DragItem | null
  onDragItem?: (item: DragItem | null) => void
  onReparentCollection?: (id: string, targetId: string) => void
  onMoveBundlesInto?: (targetId: string, alt: boolean) => void
  smartCollections: SmartCollectionRead[]
  onNewSmartCollection: () => void
  onEditSmartCollection: (sc: SmartCollectionRead) => void
  onDeleteSmartCollection: (sc: SmartCollectionRead) => void
}

interface TreeNode {
  collection: CollectionRead
  children: TreeNode[]
}

function buildTree(collections: CollectionRead[]): TreeNode[] {
  const byParent = new Map<string | null, CollectionRead[]>()
  for (const c of collections) {
    const key = c.parent_id ?? null
    const list = byParent.get(key) ?? []
    list.push(c)
    byParent.set(key, list)
  }
  const make = (parent: string | null): TreeNode[] =>
    (byParent.get(parent) ?? [])
      // Manual order (drag-reorder / Clean up by…), name as the stable tie-break.
      .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
      .map((collection) => ({ collection, children: make(collection.id) }))
  return make(null)
}

export function Sidebar({
  mode,
  onMode,
  libraries,
  libraryId,
  onChangeLibrary,
  onManageLibraries,
  onOpenSettings,
  canLock,
  onLock,
  onUpdateLibrary,
  updating,
  onScanFiles,
  scanningFiles,
  onProbe,
  probing,
  onGenerateStoryboards,
  generatingStoryboards,
  onReviewGrouping,
  activeJob,
  maintenanceError,
  selection,
  onSelect,
  onOpenUnbundled,
  onOpenAllTags,
  fileScope,
  counts,
  collections,
  collectionCounts,
  onDeleteCollection,
  onCreateCollection,
  onRenameCollection,
  onReorderCollections,
  onMoveCollection,
  onCleanupCollections,
  dragItem = null,
  onDragItem,
  onReparentCollection,
  onMoveBundlesInto,
  smartCollections,
  onNewSmartCollection,
  onEditSmartCollection,
  onDeleteSmartCollection,
}: SidebarProps) {
  const [jobsMenuOpen, setJobsMenuOpen] = useState(false)
  const menu = useContextMenu()
  // Drop feedback for the hovered collection row (before/after = reorder gap,
  // into = reparent/add). The dragged payload comes from the App-level dragItem.
  const [dropSlot, setDropSlot] = useState<{
    id: string
    zone: 'before' | 'into' | 'after'
  } | null>(null)
  // Fold state for the two sidebar sections (persisted).
  const [smartCollapsed, setSmartCollapsed] = usePersistentState(
    'cairndex.sidebar.smartCollapsed',
    false,
  )
  const [collectionsCollapsed, setCollectionsCollapsed] = usePersistentState(
    'cairndex.sidebar.collectionsCollapsed',
    false,
  )

  // Id of the collection currently showing an inline rename box — set right
  // after "+ Collection" creates one, so the user can type its name in place.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)
  // Branch expand/collapse is normally per-node local state (depth 0 open by
  // default), but creating a collection nested under the currently open one
  // needs to force its ancestor chain open so the new node is visible.
  const [expandedOverride, setExpandedOverride] = useState<Set<string>>(new Set())
  const [collapsedOverride, setCollapsedOverride] = useState<Set<string>>(new Set())
  const isExpanded = (id: string, depth: number) =>
    expandedOverride.has(id) ? true : collapsedOverride.has(id) ? false : depth < 1
  const toggleExpanded = (id: string, depth: number) => {
    const willExpand = !isExpanded(id, depth)
    setExpandedOverride((prev) => {
      const s = new Set(prev)
      if (willExpand) s.add(id)
      else s.delete(id)
      return s
    })
    setCollapsedOverride((prev) => {
      const s = new Set(prev)
      if (willExpand) s.delete(id)
      else s.add(id)
      return s
    })
  }

  // Every collection in the active library is shown (collections are per-library
  // under ADR-0008), including empty ones — a folder shouldn't vanish just
  // because it has no bundles yet.
  const tree = useMemo(() => buildTree(collections), [collections])

  // "+ Collection": create it under the collection currently open (or at the
  // top level when browsing a system view/smart collection), pick a name
  // that doesn't collide with its siblings, expand its ancestor chain so it's
  // visible, then drop straight into the inline rename box.
  const handleNewCollection = () => {
    setCreateError(null)
    const parentId = selection.collectionId ?? null
    const siblingNames = new Set(
      collections.filter((c) => (c.parent_id ?? null) === parentId).map((c) => c.name),
    )
    let name = 'New Collection'
    for (let n = 2; siblingNames.has(name); n++) name = `New Collection ${n}`

    onCreateCollection(
      { name, parent_id: parentId },
      {
        onSuccess: (created) => {
          if (parentId) {
            const ancestors = new Set<string>()
            let cur: string | null = parentId
            while (cur) {
              ancestors.add(cur)
              cur = collections.find((c) => c.id === cur)?.parent_id ?? null
            }
            setExpandedOverride((prev) => new Set([...prev, ...ancestors]))
            setCollapsedOverride((prev) => {
              const s = new Set(prev)
              for (const id of ancestors) s.delete(id)
              return s
            })
          }
          setEditingId(created.id)
        },
        onError: (err) => setCreateError(err instanceof Error ? err.message : 'Could not create'),
      },
    )
  }

  const collectionMenu = (collection: CollectionRead, e: React.MouseEvent) =>
    menu.open(e, [
      { label: 'Delete Collection', danger: true, onClick: () => onDeleteCollection(collection) },
    ])

  const smartMenu = (sc: SmartCollectionRead, e: React.MouseEvent) => {
    const items: MenuEntry[] = [
      { label: 'Edit', onClick: () => onEditSmartCollection(sc) },
      null,
      { label: 'Delete', danger: true, onClick: () => onDeleteSmartCollection(sc) },
    ]
    menu.open(e, items)
  }

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <span>🍃</span> Cairndex
      </div>

      <div className="sidebar__library">
        <select
          className="edit sidebar__library-select"
          value={libraryId ?? ''}
          onChange={(e) => onChangeLibrary(e.target.value)}
          aria-label="Library"
          disabled={libraries.length === 0}
        >
          {libraries.length === 0 && <option value="">No libraries</option>}
          {libraries.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
        {canLock && (
          <button
            className="sidebar__library-manage"
            onClick={onLock}
            aria-label="Lock library"
            title="Lock this library"
          >
            🔒
          </button>
        )}
        <button
          className="sidebar__library-manage"
          onClick={onManageLibraries}
          aria-label="Manage libraries"
          title="Manage libraries"
        >
          +
        </button>
      </div>

      <div className="sidebar__jobs" role="group" aria-label="Library maintenance">
        <button
          className="sidebar__job"
          onClick={onUpdateLibrary}
          title="Scan files, prepare grouping suggestions, collect media metadata, and generate storyboards"
          disabled={updating || libraryId === null}
        >
          {updating ? '⟳ Updating…' : '⟳ Update'}
        </button>
        <div className="sidebar__job-menu">
          <button
            className="sidebar__job-more"
            onClick={() => setJobsMenuOpen((open) => !open)}
            title="More library maintenance actions"
            aria-label="More library maintenance actions"
            aria-expanded={jobsMenuOpen}
            disabled={libraryId === null}
          >
            ⋯
          </button>
          {jobsMenuOpen && (
            <div className="sidebar__job-popover">
              <button
                onClick={() => {
                  setJobsMenuOpen(false)
                  onScanFiles()
                }}
                disabled={scanningFiles}
              >
                {scanningFiles ? 'Scanning…' : 'Scan new files'}
              </button>
              <button
                onClick={() => {
                  setJobsMenuOpen(false)
                  onProbe()
                }}
                disabled={probing}
              >
                {probing ? 'Collecting…' : 'Collect metadata'}
              </button>
              <button
                onClick={() => {
                  setJobsMenuOpen(false)
                  onReviewGrouping()
                }}
                title="Suggest grouping for every uncategorized bundle and unbundled file"
              >
                Suggest grouping
              </button>
              <button
                onClick={() => {
                  setJobsMenuOpen(false)
                  onGenerateStoryboards()
                }}
                disabled={generatingStoryboards}
              >
                {generatingStoryboards ? 'Generating…' : 'Generate storyboards'}
              </button>
            </div>
          )}
        </div>
      </div>

      {activeJob && (
        <div className="sidebar__job-progress">
          <JobProgress job={activeJob} />
        </div>
      )}
      {!activeJob && maintenanceError && (
        <div className="sidebar__job-error" role="alert">
          {maintenanceError}
        </div>
      )}

      <div className="sidebar__modes" role="tablist" aria-label="Browsing surface">
        <button
          role="tab"
          aria-selected={mode === 'collection'}
          className={`mode-tab${mode === 'collection' ? ' mode-tab--active' : ''}`}
          onClick={() => onMode('collection')}
        >
          Bundles
        </button>
        <button
          role="tab"
          aria-selected={mode === 'file'}
          className={`mode-tab${mode === 'file' ? ' mode-tab--active' : ''}`}
          onClick={() => onMode('file')}
        >
          Files
        </button>
      </div>

      <div className="sidebar__section">
        {SYSTEM_VIEWS.map((v) => {
          // Unbundled lives in the Files surface; the rest are bundle browse
          // views (only active in Bundles mode).
          const isUnbundled = v.view === 'unbundled'
          // Unbundled and Missing Files are "needs attention" queues: highlight a
          // non-zero count (zero stays neutral).
          const hinted = isUnbundled || v.view === 'missing'
          const count = counts?.[v.view]
          const active = isUnbundled
            ? mode === 'file' && fileScope === 'unbundled'
            : mode === 'collection' && selection.collectionId === null && selection.view === v.view
          return (
            <Fragment key={v.view}>
              <button
                className={`nav-item${active ? ' nav-item--active' : ''}`}
                title={
                  v.view === 'missing' ? 'Bundles containing one or more missing files' : undefined
                }
                onClick={() =>
                  isUnbundled ? onOpenUnbundled?.() : onSelect({ view: v.view, collectionId: null })
                }
              >
                <span className="nav-item__icon">{viewIcon(v.view)}</span>
                <span className="nav-item__label">{v.label}</span>
                {count !== undefined && (
                  <span
                    className={`nav-item__count${
                      hinted && count > 0 ? ' nav-item__count--hint' : ''
                    }`}
                  >
                    {v.view === 'missing'
                      ? `${count} ${count === 1 ? 'bundle' : 'bundles'}`
                      : count}
                  </span>
                )}
              </button>
            </Fragment>
          )
        })}
        {/* All Tags (a management surface, not a browse view) sits at the bottom
            of the system section, below the Unbundled/Missing queues. */}
        <button
          className={`nav-item${mode === 'tags' ? ' nav-item--active' : ''}`}
          onClick={() => onOpenAllTags?.()}
        >
          <span className="nav-item__icon">
            <IconTag />
          </span>
          <span className="nav-item__label">All Tags</span>
        </button>
      </div>

      <div className="sidebar__section">
        <SectionHeading
          label="Smart Collections"
          collapsed={smartCollapsed}
          onToggle={() => setSmartCollapsed(!smartCollapsed)}
          onAdd={onNewSmartCollection}
          addLabel="New smart collection"
        />
        {!smartCollapsed &&
          smartCollections.map((sc) => {
            const active = selection.smartCollectionId === sc.id
            return (
              <div
                key={sc.id}
                className={`nav-item${active ? ' nav-item--active' : ''}`}
                onClick={() =>
                  onSelect({ view: 'all', collectionId: null, smartCollectionId: sc.id })
                }
                onContextMenu={(e) => smartMenu(sc, e)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ')
                    onSelect({ view: 'all', collectionId: null, smartCollectionId: sc.id })
                }}
              >
                <span className="nav-item__icon">
                  <IconFilter />
                </span>
                <span className="nav-item__label">{sc.name}</span>
                <button
                  className="nav-item__edit"
                  onClick={(e) => {
                    e.stopPropagation()
                    onEditSmartCollection(sc)
                  }}
                  aria-label={`Edit ${sc.name}`}
                >
                  ✎
                </button>
              </div>
            )
          })}
      </div>

      <div className="sidebar__section">
        <SectionHeading
          label="Collections"
          collapsed={collectionsCollapsed}
          onToggle={() => setCollectionsCollapsed(!collectionsCollapsed)}
          onAdd={handleNewCollection}
          addLabel="New collection"
          addTitle={
            selection.collectionId
              ? 'New collection inside the current one'
              : 'New top-level collection'
          }
          onContextMenu={
            onCleanupCollections
              ? (e) => menu.open(e, [{ label: 'Clean Up Order…', onClick: onCleanupCollections }])
              : undefined
          }
        />
        {!collectionsCollapsed && (
          <>
            {createError && (
              <div className="sidebar__heading" role="alert">
                {createError}
              </div>
            )}
            {tree.length === 0 && <div className="sidebar__heading">No collections yet</div>}
            {tree.map((node, i) => (
              <CollectionBranch
                key={node.collection.id}
                node={node}
                depth={0}
                trail={[]}
                isLast={i === tree.length - 1}
                parentId={null}
                siblingIds={tree.map((n) => n.collection.id)}
                selection={selection}
                onSelect={onSelect}
                onContextMenu={collectionMenu}
                collectionCounts={collectionCounts}
                isExpanded={isExpanded}
                onToggle={toggleExpanded}
                editingId={editingId}
                onRenameCollection={onRenameCollection}
                onDoneEditing={() => setEditingId(null)}
                dragItem={dragItem}
                onDragItem={onDragItem}
                dropSlot={dropSlot}
                onDropSlot={setDropSlot}
                onReorderCollections={onReorderCollections}
                onMoveCollection={onMoveCollection}
                onReparentCollection={onReparentCollection}
                onMoveBundlesInto={onMoveBundlesInto}
              />
            ))}
            {/* A drop target below the last row so a collection can be dropped in
                the empty space "behind the last collection" to land at the end of
                the top level (reordering, or moving a subcollection out). */}
            {tree.length > 0 && (
              <CollectionListEnd
                topLevelIds={tree.map((n) => n.collection.id)}
                dragItem={dragItem}
                onMoveCollection={onMoveCollection}
                onReorderCollections={onReorderCollections}
                onEndDrag={() => {
                  onDragItem?.(null)
                  setDropSlot(null)
                }}
              />
            )}
          </>
        )}
      </div>

      <button className="nav-item sidebar__settings" onClick={onOpenSettings}>
        <span className="nav-item__icon">
          <IconSettings />
        </span>
        <span className="nav-item__label">Settings</span>
      </button>

      <ContextMenu state={menu.state} onClose={menu.close} />
    </aside>
  )
}

/** A foldable sidebar section heading (Collections / Smart Collections). The
 * whole row toggles the fold and highlights on hover (like a collection row); a
 * caret appears on hover to the right of the label. The "+" add button and an
 * optional right-click menu sit alongside. */
function SectionHeading({
  label,
  collapsed,
  onToggle,
  onAdd,
  addLabel,
  addTitle,
  onContextMenu,
}: {
  label: string
  collapsed: boolean
  onToggle: () => void
  onAdd: () => void
  addLabel: string
  addTitle?: string
  onContextMenu?: (e: React.MouseEvent) => void
}) {
  return (
    <div className="sidebar__heading sidebar__heading--row" onContextMenu={onContextMenu}>
      {/* The label+caret is its own button (the highlighted "text box" that folds
          the section); the "+" add button stays separate so each has a distinct
          accessible name. */}
      <button className="sidebar__heading-toggle" onClick={onToggle} aria-expanded={!collapsed}>
        {label}
        <span className="sidebar__heading-caret">
          <IconChevron open={!collapsed} className="chevron chevron--lg" />
        </span>
      </button>
      <button className="sidebar__add" onClick={onAdd} aria-label={addLabel} title={addTitle}>
        +
      </button>
    </div>
  )
}

function CollectionBranch({
  node,
  depth,
  trail,
  isLast,
  parentId,
  siblingIds,
  selection,
  onSelect,
  onContextMenu,
  collectionCounts,
  isExpanded,
  onToggle,
  editingId,
  onRenameCollection,
  onDoneEditing,
  dragItem,
  onDragItem,
  dropSlot,
  onDropSlot,
  onReorderCollections,
  onMoveCollection,
  onReparentCollection,
  onMoveBundlesInto,
}: {
  node: TreeNode
  depth: number
  // Ancestor continuation flags (one per column, length = depth - 1) + whether
  // this row is the last of its siblings — drive the hierarchy guide rails.
  trail: boolean[]
  isLast: boolean
  parentId: string | null
  siblingIds: string[]
  selection: Selection
  onSelect: (selection: Selection) => void
  onContextMenu: (collection: CollectionRead, e: React.MouseEvent) => void
  collectionCounts?: Record<string, number>
  isExpanded: (id: string, depth: number) => boolean
  onToggle: (id: string, depth: number) => void
  editingId: string | null
  onRenameCollection: SidebarProps['onRenameCollection']
  onDoneEditing: () => void
  dragItem: DragItem | null
  onDragItem?: (item: DragItem | null) => void
  dropSlot: { id: string; zone: 'before' | 'into' | 'after' } | null
  onDropSlot: (v: { id: string; zone: 'before' | 'into' | 'after' } | null) => void
  onReorderCollections: SidebarProps['onReorderCollections']
  onMoveCollection?: SidebarProps['onMoveCollection']
  onReparentCollection?: (id: string, targetId: string) => void
  onMoveBundlesInto?: (targetId: string, alt: boolean) => void
}) {
  const active = selection.collectionId === node.collection.id
  const hasChildren = node.children.length > 0
  const expanded = isExpanded(node.collection.id, depth)
  const editing = editingId === node.collection.id
  const id = node.collection.id
  // Only reflect the hover slot while a drag is live — a bundle drag begins in
  // the Browser and never fires a sidebar row's onDragEnd, so gating on dragItem
  // prevents the highlight from sticking after such a drag ends.
  const slotZone = dragItem && dropSlot?.id === id ? dropSlot.zone : null
  const endDrag = () => {
    onDragItem?.(null)
    onDropSlot(null)
  }

  return (
    <>
      <div
        className={`nav-item collection-row${active ? ' nav-item--active' : ''}${
          slotZone === 'into' ? ' collection-row--drop-into' : ''
        }`}
        data-drop={slotZone && slotZone !== 'into' ? slotZone : undefined}
        onClick={() => !editing && onSelect({ view: 'all', collectionId: id })}
        onContextMenu={(e) => onContextMenu(node.collection, e)}
        role="treeitem"
        aria-selected={active}
        draggable={!editing}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move'
          onDragItem?.({ kind: 'collection', id })
        }}
        onDragEnd={endDrag}
        onDragOver={(e) => {
          // Bundles → move into this collection; a folder → drop on the top/bottom
          // edge to place before/after this row (reorder within, or reparent into,
          // this row's group), or on the middle to reparent *into* this collection.
          let zone: 'before' | 'into' | 'after' | null = null
          if (dragItem?.kind === 'bundles') {
            zone = 'into'
            e.dataTransfer.dropEffect = e.altKey ? 'copy' : 'move'
          } else if (dragItem?.kind === 'collection' && dragItem.id !== id) {
            const r = e.currentTarget.getBoundingClientRect()
            zone = dropZone(e, r, 'vertical', true)
          }
          if (zone === null) return
          e.preventDefault()
          if (dropSlot?.id !== id || dropSlot.zone !== zone) onDropSlot({ id, zone })
        }}
        onDrop={(e) => {
          if (!dragItem) return
          if (dragItem.kind === 'bundles') {
            e.preventDefault()
            onMoveBundlesInto?.(id, e.altKey)
          } else if (dragItem.id !== id) {
            e.preventDefault()
            // Recompute the zone from the cursor at drop time — the last dragover
            // may not have settled on this row, and a stale slot would silently
            // turn an intended reorder into a reparent ("move fails" ~1 in 8).
            const r = e.currentTarget.getBoundingClientRect()
            const zone = dropZone(e, r, 'vertical', true)
            if (zone === 'into') {
              onReparentCollection?.(dragItem.id, id)
            } else if (siblingIds.includes(dragItem.id)) {
              onReorderCollections(parentId, moveTo(siblingIds, dragItem.id, id, zone === 'before'))
            } else {
              // From another parent group: reparent into this row's group at the slot.
              onMoveCollection?.(
                dragItem.id,
                parentId,
                moveTo([...siblingIds, dragItem.id], dragItem.id, id, zone === 'before'),
              )
            }
          }
          endDrag()
        }}
      >
        <PickGuides depth={depth} trail={trail} isLast={isLast} />
        <button
          className="collection-row__toggle"
          onClick={(e) => {
            e.stopPropagation()
            onToggle(node.collection.id, depth)
          }}
          aria-label={expanded ? 'Collapse' : 'Expand'}
        >
          {hasChildren ? <IconChevron open={expanded} /> : ''}
        </button>
        <span className="nav-item__icon">
          <IconFolder />
        </span>
        {editing ? (
          <CollectionRenameInput
            collection={node.collection}
            onRenameCollection={onRenameCollection}
            onDone={onDoneEditing}
          />
        ) : (
          <>
            <span className="nav-item__label">{node.collection.name}</span>
            <span className="nav-item__count">{collectionCounts?.[node.collection.id] ?? ''}</span>
          </>
        )}
      </div>
      {expanded &&
        node.children.map((child, i) => (
          <CollectionBranch
            key={child.collection.id}
            node={child}
            depth={depth + 1}
            // Top-level rows have no rail, so their children start a fresh trail;
            // deeper rows extend the trail with this node's own continuation.
            trail={depth === 0 ? [] : [...trail, !isLast]}
            isLast={i === node.children.length - 1}
            parentId={node.collection.id}
            siblingIds={node.children.map((c) => c.collection.id)}
            selection={selection}
            onSelect={onSelect}
            onContextMenu={onContextMenu}
            collectionCounts={collectionCounts}
            isExpanded={isExpanded}
            onToggle={onToggle}
            editingId={editingId}
            onRenameCollection={onRenameCollection}
            onDoneEditing={onDoneEditing}
            dragItem={dragItem}
            onDragItem={onDragItem}
            dropSlot={dropSlot}
            onDropSlot={onDropSlot}
            onReorderCollections={onReorderCollections}
            onMoveCollection={onMoveCollection}
            onReparentCollection={onReparentCollection}
            onMoveBundlesInto={onMoveBundlesInto}
          />
        ))}
    </>
  )
}

/** A slim drop target rendered after the last top-level row. Dropping a
 * collection here lands it at the end of the top level — the natural target when
 * dragging "past the last collection" into the empty space below the tree, and
 * the way to move a nested subcollection out to the top level. */
function CollectionListEnd({
  topLevelIds,
  dragItem,
  onMoveCollection,
  onReorderCollections,
  onEndDrag,
}: {
  topLevelIds: string[]
  dragItem: DragItem | null
  onMoveCollection?: SidebarProps['onMoveCollection']
  onReorderCollections: SidebarProps['onReorderCollections']
  onEndDrag: () => void
}) {
  const [over, setOver] = useState(false)
  // Only a collection drag can land here; while one is in flight the zone grows
  // to fill the empty space below the tree so "drop past the last collection" is
  // a big, forgiving target rather than a thin strip.
  const active = dragItem?.kind === 'collection'
  return (
    <div
      className={`collection-list-end${active ? ' collection-list-end--active' : ''}${
        over ? ' collection-list-end--over' : ''
      }`}
      onDragOver={(e) => {
        if (dragItem?.kind !== 'collection') return
        e.preventDefault()
        if (!over) setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false)
        if (dragItem?.kind !== 'collection') return
        e.preventDefault()
        const id = dragItem.id
        const rest = topLevelIds.filter((x) => x !== id)
        if (topLevelIds.includes(id)) {
          // Already top-level: just move it to the end.
          onReorderCollections(null, [...rest, id])
        } else {
          onMoveCollection?.(id, null, [...rest, id])
        }
        onEndDrag()
      }}
    />
  )
}

/** Inline rename box: focused with its text pre-selected so the first
 * keystroke replaces the placeholder name outright (Explorer/Finder-style
 * "New Folder" behavior). Enter/blur commits, Escape cancels. */
function CollectionRenameInput({
  collection,
  onRenameCollection,
  onDone,
}: {
  collection: CollectionRead
  onRenameCollection: SidebarProps['onRenameCollection']
  onDone: () => void
}) {
  const [value, setValue] = useState(collection.name)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Focus + select-all once on mount (not on every keystroke re-render) so
  // the first character typed replaces the placeholder name outright.
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const commit = () => {
    const trimmed = value.trim()
    if (trimmed === '' || trimmed === collection.name) {
      onDone()
      return
    }
    onRenameCollection(collection.id, trimmed, {
      onSuccess: onDone,
      onError: (err) => setError(err instanceof Error ? err.message : 'Could not rename'),
    })
  }

  return (
    <span className="nav-item__label collection-row__rename">
      <input
        ref={inputRef}
        className="edit edit--inline"
        value={value}
        onChange={(e) => {
          setValue(e.target.value)
          setError(null)
        }}
        onClick={(e) => e.stopPropagation()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            inputRef.current?.blur()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onDone()
          }
        }}
        aria-label={`Rename ${collection.name}`}
      />
      {error && (
        <span className="collection-row__rename-error" role="alert">
          {error}
        </span>
      )}
    </span>
  )
}

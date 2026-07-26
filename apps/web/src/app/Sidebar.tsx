import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type {
  CollectionRead,
  JobRead,
  LibraryRead,
  SmartCollectionRead,
  ViewCounts,
} from '../api/client'
import { ContextMenu } from './ContextMenu'
import { dragBadgeLabel, setDragBadge } from './dragBadge'
import { suppressShiftSelection } from './selection'
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
  IconLibrary,
  IconLooseStack,
  IconSettings,
  IconTag,
  IconTagQuestion,
  IconTrash,
} from './icons'
import type { DragItem, TreeDrop } from './dnd'
import { dropZone, getActiveDrag, sameTreeDrop, seamFor, setActiveDrag } from './dnd'
import { PickGuides } from './PickGuides'
import { gapBefore } from './reorder'
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

export interface SidebarProps {
  mode: AppMode
  onMode: (mode: AppMode) => void
  libraries: LibraryRead[]
  libraryId: string | null
  onChangeLibrary: (libraryId: string) => void
  onManageLibraries: () => void
  onOpenSettings: () => void
  /** Docked just above Settings — the transfer indicator's fixed home. */
  footer?: ReactNode
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
  // The collection-section multi-selection, mirrored here so sidebar rows show
  // membership; modifier-clicking a row toggles it via the callback below,
  // *without* navigating. Shift toggles like Cmd — the tree has no linear order
  // shared with the section grid, so a range would be a guess.
  multiSelectedIds?: Set<string>
  onModifierSelectCollection?: (id: string) => void
  /** Replace the multi-selection wholesale — the Shift-range result. */
  onSelectCollectionsMany?: (ids: string[]) => void
  // Unbundled is a Files-surface view (a flat "to-bundle queue"), so it routes
  // into Files mode rather than selecting a bundle browse view.
  onOpenUnbundled?: () => void
  // All Tags is a management surface (mode='tags'), not a bundle browse view.
  onOpenAllTags?: () => void
  // The Trash is a Files-surface scope like Unbundled. Shown when write mode is
  // on *or* the trash holds anything: turning write mode off must not make
  // trashed files look permanently gone (they are still recoverable, and the
  // server keeps the listing readable for exactly that reason). A library that
  // never deleted anything still shows no entry — an always-empty Trash would
  // be a permanent question about a missing feature.
  onOpenTrash?: () => void
  showTrash?: boolean
  fileScope?: 'browse' | 'unbundled' | 'trash'
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
  // Move collections to a gap in one sibling group: the dragged block, and the
  // collection it lands in front of (null = the end of the group).
  onReorderCollections: (
    parentId: string | null,
    movedIds: string[],
    beforeId: string | null,
  ) => void
  // Right-click the Collections heading → clean up the collection manual order.
  onCleanupCollections?: () => void
  // Cross-surface drag: the current payload + callbacks to reparent a collection
  // or move bundles into a collection by dropping on a sidebar row.
  dragItem?: DragItem | null
  onDragItem?: (item: DragItem | null) => void
  onReparentCollections?: (ids: string[], targetId: string) => void
  onMoveBundlesInto?: (targetId: string, alt: boolean) => void
  // Clicking the sidebar's blank space drops the current selection.
  onBackgroundClick?: () => void
  /**
   * A create-collection request raised outside the sidebar (the grid's empty-space
   * menu, the native File menu). `parentId` null means top level. The sidebar owns
   * the flow because the new row's inline rename and branch expansion are its
   * state; `onNewCollectionHandled` clears the request once consumed.
   */
  newCollectionRequest?: { parentId: string | null } | null
  onNewCollectionHandled?: () => void
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
  footer,
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
  multiSelectedIds,
  onModifierSelectCollection,
  onSelectCollectionsMany,
  onOpenUnbundled,
  onOpenAllTags,
  onOpenTrash,
  showTrash = false,
  fileScope,
  counts,
  collections,
  collectionCounts,
  onDeleteCollection,
  onCreateCollection,
  onRenameCollection,
  onReorderCollections,
  onCleanupCollections,
  dragItem = null,
  onDragItem,
  onReparentCollections,
  onMoveBundlesInto,
  onBackgroundClick,
  newCollectionRequest = null,
  onNewCollectionHandled,
  smartCollections,
  onNewSmartCollection,
  onEditSmartCollection,
  onDeleteSmartCollection,
}: SidebarProps) {
  const [jobsMenuOpen, setJobsMenuOpen] = useState(false)
  const menu = useContextMenu()
  // Drop feedback for the hovered collection row (before/after = reorder gap,
  // into = reparent/add). The dragged payload comes from the App-level dragItem.
  // Where the drop will land, named once — see DropTarget in dnd.ts. A tree gap
  // carries its parent group too: "the end of the group" means nothing without
  // knowing which group, since rows from different levels interleave on screen.
  const [dropSlot, setDropSlot] = useState<TreeDrop | null>(null)
  // A drag ending leaves the last hovered slot behind; the *next* drag showed it
  // for a beat before the first dragover corrected it. Reset as the new drag
  // begins — adjusted during render (React's reset-on-prop-change pattern)
  // rather than in an effect, which would paint the stale slot for a frame.
  const [lastDragItem, setLastDragItem] = useState(dragItem)
  if (dragItem !== lastDragItem) {
    setLastDragItem(dragItem)
    if (dragItem) setDropSlot(null)
  }
  // Fold state for the two sidebar sections (persisted).
  const [smartCollapsed, setSmartCollapsed] = usePersistentState(
    'cairndex.sidebar.smartCollapsed',
    false,
  )
  const [collectionsCollapsed, setCollectionsCollapsed] = usePersistentState(
    'cairndex.sidebar.collectionsCollapsed',
    false,
  )

  // Shift-range anchor for sidebar multi-select: the last row plainly clicked
  // or Cmd-toggled. A ref, not state — it never needs a re-render of its own.
  const rangeAnchorRef = useRef<string | null>(null)

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

  // Cmd toggles; Shift ranges over the rows as currently *visible* (respecting
  // which branches are expanded) — the order the user can actually see. Ctrl is
  // deliberately not a selection key: on macOS Ctrl-click is the context-menu
  // chord. Plain clicks and Cmd-toggles both move the range anchor.
  const modifierSelectRow = (id: string, e: React.MouseEvent) => {
    if (e.shiftKey && rangeAnchorRef.current && onSelectCollectionsMany) {
      const visible: string[] = []
      const walk = (nodes: TreeNode[], depth: number) => {
        for (const n of nodes) {
          visible.push(n.collection.id)
          if (n.children.length > 0 && isExpanded(n.collection.id, depth)) {
            walk(n.children, depth + 1)
          }
        }
      }
      walk(tree, 0)
      const a = visible.indexOf(rangeAnchorRef.current)
      const b = visible.indexOf(id)
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        onSelectCollectionsMany(visible.slice(lo, hi + 1))
        return
      }
    }
    rangeAnchorRef.current = id
    onModifierSelectCollection?.(id)
  }

  // Create a collection under an explicit parent (null = top level), pick a name
  // that doesn't collide with its siblings, expand the parent's ancestor chain so
  // the new row is visible, then drop straight into the inline rename box.
  //
  // The parent is always passed in, never inferred from the current selection:
  // "+ Collection" means top level, and nesting is its own gesture (right-click a
  // collection → New Subcollection). Inferring it from what happened to be open
  // meant the same button did two different things with no way to ask for the
  // first one while browsing a collection.
  const createCollectionUnder = useCallback(
    (parentId: string | null) => {
      setCreateError(null)
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
    },
    [collections, onCreateCollection],
  )

  // A request from outside the sidebar (the grid's empty-space menu, the native
  // File menu). It arrives as a prop rather than a callback because the sidebar
  // owns the flow — the new row's inline rename box and branch expansion are its
  // state — while the caller only names the parent. An effect is the only hook
  // available: the trigger is another pane or the OS menu, so there is no event in
  // this subtree to hang it off (mirrors App's deepLink handling).
  //
  // Consumption is tracked by request identity rather than by trusting the
  // caller's clear: `createCollectionUnder` changes identity whenever the
  // collection list refetches — which creating one causes — so a caller that
  // wired the request without the clear callback would otherwise create in a loop.
  const consumedRequestRef = useRef<{ parentId: string | null } | null>(null)
  useEffect(() => {
    if (!newCollectionRequest || consumedRequestRef.current === newCollectionRequest) return
    consumedRequestRef.current = newCollectionRequest
    createCollectionUnder(newCollectionRequest.parentId)
    onNewCollectionHandled?.()
  }, [newCollectionRequest, onNewCollectionHandled, createCollectionUnder])

  const collectionMenu = (collection: CollectionRead, e: React.MouseEvent) =>
    menu.open(e, [
      {
        label: 'New Subcollection',
        onClick: () => createCollectionUnder(collection.id),
      },
      null,
      { label: 'Delete Collection', danger: true, onClick: () => onDeleteCollection(collection) },
    ])

  // Right-clicking the Collections heading or the blank run-out below the list:
  // both mean "here", which at those spots is the top level.
  const collectionsBackgroundMenu = (e: React.MouseEvent) => {
    const items: MenuEntry[] = [
      { label: 'New Collection', onClick: () => createCollectionUnder(null) },
    ]
    if (onCleanupCollections) {
      items.push(null, { label: 'Clean Up Order…', onClick: onCleanupCollections })
    }
    menu.open(e, items)
  }

  const smartMenu = (sc: SmartCollectionRead, e: React.MouseEvent) => {
    const items: MenuEntry[] = [
      { label: 'Edit', onClick: () => onEditSmartCollection(sc) },
      null,
      { label: 'Delete', danger: true, onClick: () => onDeleteSmartCollection(sc) },
    ]
    menu.open(e, items)
  }

  return (
    <aside
      className="sidebar"
      onMouseDownCapture={suppressShiftSelection}
      // Clicking the sidebar's blank space (the gap above Settings, the run-out
      // below the last collection) drops the selection, the way clicking blank
      // space in the grid does. Without it a multi-selection built here could
      // only be undone by selecting something else.
      onClick={(e) => {
        const target = e.target as HTMLElement
        if (target.closest('.nav-item, button, input, select, textarea, label')) return
        onBackgroundClick?.()
      }}
    >
      {/* Clearance for the window's traffic lights, which float over this corner
          in the desktop shell (see `markOverlayTitleBar`). Zero-height in a
          browser. The drag regions move the window, the way the system title bar
          they replace would; "deep" covers the labels inside them too, since
          Tauri's bare attribute only matches a click on the element itself. */}
      <div className="sidebar__titlebar" data-tauri-drag-region="deep" />
      <div className="sidebar__brand" data-tauri-drag-region="deep">
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
        {/* Books, not a "+": the dialog behind it also opens and removes
            libraries, so an add glyph under-describes it. */}
        <button
          className="sidebar__library-manage"
          onClick={onManageLibraries}
          aria-label="Manage libraries"
          title="Manage libraries"
        >
          <IconLibrary />
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
                title="Suggest grouping for unbundled files and new additions"
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
                    {count}
                  </span>
                )}
              </button>
            </Fragment>
          )
        })}
        {/* All Tags (a management surface, not a browse view) sits below the
            Unbundled/Missing queues. */}
        <button
          className={`nav-item${mode === 'tags' ? ' nav-item--active' : ''}`}
          onClick={() => onOpenAllTags?.()}
        >
          <span className="nav-item__icon">
            <IconTag />
          </span>
          <span className="nav-item__label">All Tags</span>
        </button>
        {/* Trash last: it is the recoverable-deletions bin, not a browse or
            management surface, so it reads as the tail of the section. */}
        {showTrash && (
          <button
            className={`nav-item${mode === 'file' && fileScope === 'trash' ? ' nav-item--active' : ''}`}
            onClick={() => onOpenTrash?.()}
            title="Files deleted from this library, still recoverable"
          >
            <span className="nav-item__icon">
              <IconTrash />
            </span>
            <span className="nav-item__label">Trash</span>
          </button>
        )}
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

      <div
        className="sidebar__section"
        // Right-clicking this section's blank run-out — below the last row, beside
        // the heading — means "here", which at the section level is the top level.
        // Scoped to the section rather than the whole aside: the brand, the library
        // selector and the jobs strip are not collection space, and offering to
        // make a collection from the app title would be nonsense.
        onContextMenu={(e) => {
          const target = e.target as HTMLElement
          if (target.closest('.nav-item, button, input, select, textarea, label')) return
          collectionsBackgroundMenu(e)
        }}
      >
        <SectionHeading
          label="Collections"
          collapsed={collectionsCollapsed}
          onToggle={() => setCollectionsCollapsed(!collectionsCollapsed)}
          onAdd={() => createCollectionUnder(null)}
          addLabel="New collection"
          // Always the top level, whatever is open. Nesting is the collection
          // row's own right-click menu.
          addTitle="New top-level collection"
          onContextMenu={collectionsBackgroundMenu}
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
                onSelect={(sel) => {
                  if (sel.collectionId) rangeAnchorRef.current = sel.collectionId
                  onSelect(sel)
                }}
                multiSelectedIds={multiSelectedIds}
                onModifierSelect={modifierSelectRow}
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
                onReparentCollections={onReparentCollections}
                onMoveBundlesInto={onMoveBundlesInto}
              />
            ))}
            {/* A drop target below the last row so a collection can be dropped in
                the empty space "behind the last collection" to land at the end of
                the top level (reordering, or moving a subcollection out). */}
            {tree.length > 0 && (
              <CollectionListEnd
                dragItem={dragItem}
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

      {/* Pinned to the bottom (margin-top:auto) so Settings is where it is
          expected rather than trailing whatever the nav happens to end at, and
          so a transfer indicator has a fixed home directly above it. */}
      <div className="sidebar__foot">
        {footer}
        <button className="nav-item sidebar__settings" onClick={onOpenSettings}>
          <span className="nav-item__icon">
            <IconSettings />
          </span>
          <span className="nav-item__label">Settings</span>
        </button>
      </div>

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
  multiSelectedIds,
  onModifierSelect,
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
  onReparentCollections,
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
  multiSelectedIds?: Set<string>
  onModifierSelect?: (id: string, e: React.MouseEvent) => void
  onContextMenu: (collection: CollectionRead, e: React.MouseEvent) => void
  collectionCounts?: Record<string, number>
  isExpanded: (id: string, depth: number) => boolean
  onToggle: (id: string, depth: number) => void
  editingId: string | null
  onRenameCollection: SidebarProps['onRenameCollection']
  onDoneEditing: () => void
  dragItem: DragItem | null
  onDragItem?: (item: DragItem | null) => void
  dropSlot: TreeDrop | null
  onDropSlot: (v: TreeDrop | null) => void
  onReorderCollections: SidebarProps['onReorderCollections']
  onReparentCollections?: (ids: string[], targetId: string) => void
  onMoveBundlesInto?: (targetId: string, alt: boolean) => void
}) {
  const active =
    selection.collectionId === node.collection.id ||
    (multiSelectedIds?.has(node.collection.id) ?? false)
  const hasChildren = node.children.length > 0
  const expanded = isExpanded(node.collection.id, depth)
  const editing = editingId === node.collection.id
  const id = node.collection.id
  // Only reflect the hover slot while a drag is live — a bundle drag begins in
  // the Browser and never fires a sidebar row's onDragEnd, so gating on dragItem
  // prevents the highlight from sticking after such a drag ends.
  // One seam per destination: a leading line on the row the block lands before,
  // or a trailing line on the last row of the group when it lands at the end.
  // Never both sides of one gap.
  const seam =
    dropSlot?.kind === 'gap' && dropSlot.parentId === parentId
      ? seamFor({ kind: 'gap', beforeId: dropSlot.beforeId }, id, siblingIds)
      : undefined
  const nesting = dropSlot?.kind === 'into' && dropSlot.id === id
  const endDrag = () => {
    setActiveDrag(null)
    onDragItem?.(null)
    onDropSlot(null)
  }

  return (
    <>
      <div
        className={`nav-item collection-row${active ? ' nav-item--active' : ''}${
          nesting ? ' collection-row--drop-into' : ''
        }`}
        data-drop={seam}
        onClick={(e) => {
          if (editing) return
          if ((e.metaKey || e.shiftKey) && onModifierSelect) {
            // Build a multi-selection in place; navigation stays on plain click.
            onModifierSelect(id, e)
            return
          }
          onSelect({ view: 'all', collectionId: id })
        }}
        onContextMenu={(e) => onContextMenu(node.collection, e)}
        role="treeitem"
        aria-selected={active}
        draggable={!editing}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move'
          // Grabbing a row that is part of a multi-selection drags the whole
          // selection; grabbing anything else drags just it.
          const ids =
            multiSelectedIds && multiSelectedIds.has(id) && multiSelectedIds.size > 1
              ? [...multiSelectedIds]
              : [id]
          setDragBadge(e, dragBadgeLabel(ids.length, node.collection.name, 'collection'))
          setActiveDrag({ kind: 'collection', id, ids })
          onDragItem?.({ kind: 'collection', id, ids })
        }}
        onDragEnd={endDrag}
        onDragOver={(e) => {
          // Bundles → move into this collection; a folder → drop on the top/bottom
          // edge to place before/after this row (reorder within, or reparent into,
          // this row's group), or on the middle to reparent *into* this collection.
          // Reads the synchronous drag store, not the prop: a fast drag delivers
          // these events before React commits the dragstart's state (see dnd.ts).
          const live = getActiveDrag() ?? dragItem
          let zone: 'before' | 'into' | 'after' | null = null
          if (live?.kind === 'bundles') {
            zone = 'into'
            e.dataTransfer.dropEffect = e.altKey ? 'copy' : 'move'
          } else if (live?.kind === 'collection' && !live.ids.includes(id)) {
            const r = e.currentTarget.getBoundingClientRect()
            zone = dropZone(e, r, 'vertical', true)
          }
          if (zone === null) return
          e.preventDefault()
          const target: TreeDrop =
            zone === 'into'
              ? { kind: 'into', id }
              : {
                  kind: 'gap',
                  parentId,
                  // Collapsed to "before the next row": one name per gap, and the
                  // exact value the server is sent. For a row with children
                  // showing, that also puts the line below them — where the next
                  // sibling actually starts — instead of under the row itself,
                  // which read as "make this a child".
                  beforeId: gapBefore(siblingIds, live?.ids ?? [], id, zone),
                }
          if (!sameTreeDrop(dropSlot, target)) onDropSlot(target)
        }}
        onDrop={(e) => {
          const live = getActiveDrag() ?? dragItem
          if (!live) return
          if (live.kind === 'bundles') {
            e.preventDefault()
            onMoveBundlesInto?.(id, e.altKey)
          } else if (!live.ids.includes(id)) {
            e.preventDefault()
            // Recompute the zone from the cursor at drop time — the last dragover
            // may not have settled on this row, and a stale slot would silently
            // turn an intended reorder into a reparent ("move fails" ~1 in 8).
            const r = e.currentTarget.getBoundingClientRect()
            const zone = dropZone(e, r, 'vertical', true)
            const dragged = live.ids
            if (zone === 'into') {
              onReparentCollections?.(dragged, id)
              endDrag()
              return
            }
            // One callback for every case: this row's group is the destination,
            // and a collection arriving from another level is reparented by the
            // same request.
            onReorderCollections(parentId, dragged, gapBefore(siblingIds, dragged, id, zone))
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
            multiSelectedIds={multiSelectedIds}
            onModifierSelect={onModifierSelect}
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
            onReparentCollections={onReparentCollections}
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
  dragItem,
  onReorderCollections,
  onEndDrag,
}: {
  dragItem: DragItem | null
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
        if ((getActiveDrag() ?? dragItem)?.kind !== 'collection') return
        e.preventDefault()
        if (!over) setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false)
        const live = getActiveDrag() ?? dragItem
        if (live?.kind !== 'collection') return
        e.preventDefault()
        // Past the last row means the end of the top level — for a nested
        // collection just as much as one already there.
        onReorderCollections(null, live.ids, null)
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

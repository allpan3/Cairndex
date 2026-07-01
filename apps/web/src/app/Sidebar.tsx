import { useMemo, useState } from 'react'

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
  IconCircleDashed,
  IconClock,
  IconFilter,
  IconFolder,
  IconGrid,
  IconLooseStack,
  IconTag,
} from './icons'
import { SYSTEM_VIEWS, type AppMode, type Selection } from './types'

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
      return <IconCircleDashed />
    case 'untagged':
      return <IconTag />
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
  canLock?: boolean
  onLock?: () => void
  onUpdateLibrary: () => void
  updating?: boolean
  onScanFiles: () => void
  scanningFiles?: boolean
  onProbe: () => void
  probing?: boolean
  onReviewGrouping: () => void
  activeJob?: JobRead | null
  maintenanceError?: string | null
  selection: Selection
  onSelect: (selection: Selection) => void
  // Unbundled is a Files-surface view (a flat "to-bundle queue"), so it routes
  // into Files mode rather than selecting a bundle browse view.
  onOpenUnbundled?: () => void
  fileScope?: 'browse' | 'unbundled'
  counts?: ViewCounts
  collections: CollectionRead[]
  collectionCounts?: Record<string, number>
  onDeleteCollection: (collection: CollectionRead) => void
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
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((collection) => ({ collection, children: make(collection.id) }))
  return make(null)
}

/**
 * Prune the tree to collections relevant to the active library: keep a node if
 * it (or any descendant) has at least one bundle in the current library. The
 * supplied counts are already library-scoped, so an empty-in-this-library
 * collection drops out. While counts are still loading the full tree is shown
 * (avoids a flash of "no collections"). The global collection list is left
 * untouched for the collection picker — only the sidebar display is scoped.
 */
function pruneTree(nodes: TreeNode[], counts?: Record<string, number>): TreeNode[] {
  if (!counts) return nodes
  const keep = (n: TreeNode): TreeNode | null => {
    const children = n.children.map(keep).filter((c): c is TreeNode => c !== null)
    const hasOwn = (counts[n.collection.id] ?? 0) > 0
    return hasOwn || children.length > 0 ? { collection: n.collection, children } : null
  }
  return nodes.map(keep).filter((c): c is TreeNode => c !== null)
}

export function Sidebar({
  mode,
  onMode,
  libraries,
  libraryId,
  onChangeLibrary,
  onManageLibraries,
  canLock,
  onLock,
  onUpdateLibrary,
  updating,
  onScanFiles,
  scanningFiles,
  onProbe,
  probing,
  onReviewGrouping,
  activeJob,
  maintenanceError,
  selection,
  onSelect,
  onOpenUnbundled,
  fileScope,
  counts,
  collections,
  collectionCounts,
  onDeleteCollection,
  smartCollections,
  onNewSmartCollection,
  onEditSmartCollection,
  onDeleteSmartCollection,
}: SidebarProps) {
  const [jobsMenuOpen, setJobsMenuOpen] = useState(false)
  const menu = useContextMenu()
  // Scope the displayed collections to the active library (counts are already
  // library-scoped); the global list stays available to the collection picker.
  const tree = useMemo(
    () => pruneTree(buildTree(collections), collectionCounts),
    [collections, collectionCounts],
  )

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
          title="Scan files, prepare grouping suggestions, and update media metadata"
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
              >
                Review grouping
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
          const active = isUnbundled
            ? mode === 'file' && fileScope === 'unbundled'
            : mode === 'collection' && selection.collectionId === null && selection.view === v.view
          return (
            <button
              key={v.view}
              className={`nav-item${active ? ' nav-item--active' : ''}`}
              onClick={() =>
                isUnbundled ? onOpenUnbundled?.() : onSelect({ view: v.view, collectionId: null })
              }
            >
              <span className="nav-item__icon">{viewIcon(v.view)}</span>
              <span className="nav-item__label">{v.label}</span>
              {counts && (
                <span
                  className={`nav-item__count${
                    isUnbundled && counts[v.view] > 0 ? ' nav-item__count--hint' : ''
                  }`}
                >
                  {counts[v.view]}
                </span>
              )}
            </button>
          )
        })}
      </div>

      <div className="sidebar__section">
        <div className="sidebar__heading sidebar__heading--row">
          Smart Collections
          <button
            className="sidebar__add"
            onClick={onNewSmartCollection}
            aria-label="New smart collection"
          >
            +
          </button>
        </div>
        {smartCollections.map((sc) => {
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
        <div className="sidebar__heading">Collections</div>
        {tree.length === 0 && <div className="sidebar__heading">No collections yet</div>}
        {tree.map((node) => (
          <CollectionBranch
            key={node.collection.id}
            node={node}
            depth={0}
            selection={selection}
            onSelect={onSelect}
            onContextMenu={collectionMenu}
            collectionCounts={collectionCounts}
          />
        ))}
      </div>

      <ContextMenu state={menu.state} onClose={menu.close} />
    </aside>
  )
}

function CollectionBranch({
  node,
  depth,
  selection,
  onSelect,
  onContextMenu,
  collectionCounts,
}: {
  node: TreeNode
  depth: number
  selection: Selection
  onSelect: (selection: Selection) => void
  onContextMenu: (collection: CollectionRead, e: React.MouseEvent) => void
  collectionCounts?: Record<string, number>
}) {
  const [expanded, setExpanded] = useState(depth < 1)
  const active = selection.collectionId === node.collection.id
  const hasChildren = node.children.length > 0

  return (
    <>
      <div
        className={`nav-item collection-row${active ? ' nav-item--active' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => onSelect({ view: 'all', collectionId: node.collection.id })}
        onContextMenu={(e) => onContextMenu(node.collection, e)}
        role="treeitem"
        aria-selected={active}
      >
        <button
          className="collection-row__toggle"
          onClick={(e) => {
            e.stopPropagation()
            setExpanded((v) => !v)
          }}
          aria-label={expanded ? 'Collapse' : 'Expand'}
        >
          {hasChildren ? (expanded ? '▾' : '▸') : ''}
        </button>
        <span className="nav-item__icon">
          <IconFolder />
        </span>
        <span className="nav-item__label">{node.collection.name}</span>
        <span className="nav-item__count">{collectionCounts?.[node.collection.id] ?? ''}</span>
      </div>
      {expanded &&
        node.children.map((child) => (
          <CollectionBranch
            key={child.collection.id}
            node={child}
            depth={depth + 1}
            selection={selection}
            onSelect={onSelect}
            onContextMenu={onContextMenu}
            collectionCounts={collectionCounts}
          />
        ))}
    </>
  )
}

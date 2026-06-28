import { useMemo, useState } from 'react'

import type {
  CollectionRead,
  SmartCollectionRead,
  StorageRootRead,
  ViewCounts,
} from '../api/client'
import {
  IconAlert,
  IconCircleDashed,
  IconClock,
  IconFilter,
  IconFolder,
  IconGrid,
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
  }
}

interface SidebarProps {
  mode: AppMode
  onMode: (mode: AppMode) => void
  roots: StorageRootRead[]
  rootId: string | null
  onChangeRoot: (rootId: string) => void
  onManageLibraries: () => void
  selection: Selection
  onSelect: (selection: Selection) => void
  counts?: ViewCounts
  collections: CollectionRead[]
  collectionCounts?: Record<string, number>
  smartCollections: SmartCollectionRead[]
  onNewSmartCollection: () => void
  onEditSmartCollection: (sc: SmartCollectionRead) => void
  onImport: () => void
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
  roots,
  rootId,
  onChangeRoot,
  onManageLibraries,
  selection,
  onSelect,
  counts,
  collections,
  collectionCounts,
  smartCollections,
  onNewSmartCollection,
  onEditSmartCollection,
  onImport,
}: SidebarProps) {
  // Scope the displayed collections to the active library (counts are already
  // library-scoped); the global list stays available to the collection picker.
  const tree = useMemo(
    () => pruneTree(buildTree(collections), collectionCounts),
    [collections, collectionCounts],
  )

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <span>🍃</span> Cairndex
        <button
          className="sidebar__import"
          onClick={onImport}
          aria-label="Import from Eagle"
          title="Import from Eagle"
        >
          ⇪
        </button>
      </div>

      <div className="sidebar__library">
        <select
          className="edit sidebar__library-select"
          value={rootId ?? ''}
          onChange={(e) => onChangeRoot(e.target.value)}
          aria-label="Library"
          disabled={roots.length === 0}
        >
          {roots.length === 0 && <option value="">No libraries</option>}
          {roots.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <button
          className="sidebar__library-manage"
          onClick={onManageLibraries}
          aria-label="Manage libraries"
          title="Manage libraries"
        >
          +
        </button>
      </div>

      <div className="sidebar__modes" role="tablist" aria-label="Browsing surface">
        <button
          role="tab"
          aria-selected={mode === 'collection'}
          className={`mode-tab${mode === 'collection' ? ' mode-tab--active' : ''}`}
          onClick={() => onMode('collection')}
        >
          Collections
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
          const active = selection.collectionId === null && selection.view === v.view
          return (
            <button
              key={v.view}
              className={`nav-item${active ? ' nav-item--active' : ''}`}
              onClick={() => onSelect({ view: v.view, collectionId: null })}
            >
              <span className="nav-item__icon">{viewIcon(v.view)}</span>
              <span className="nav-item__label">{v.label}</span>
              {counts && <span className="nav-item__count">{counts[v.view]}</span>}
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
            collectionCounts={collectionCounts}
          />
        ))}
      </div>
    </aside>
  )
}

function CollectionBranch({
  node,
  depth,
  selection,
  onSelect,
  collectionCounts,
}: {
  node: TreeNode
  depth: number
  selection: Selection
  onSelect: (selection: Selection) => void
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
            collectionCounts={collectionCounts}
          />
        ))}
    </>
  )
}

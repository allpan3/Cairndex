import { useMemo, useState } from 'react'

import type { CollectionRead, SmartCollectionRead, ViewCounts } from '../api/client'
import { SYSTEM_VIEWS, type Selection } from './types'

interface SidebarProps {
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

export function Sidebar({
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
  const tree = useMemo(() => buildTree(collections), [collections])

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

      <div className="sidebar__section">
        {SYSTEM_VIEWS.map((v) => {
          const active = selection.collectionId === null && selection.view === v.view
          return (
            <button
              key={v.view}
              className={`nav-item${active ? ' nav-item--active' : ''}`}
              onClick={() => onSelect({ view: v.view, collectionId: null })}
            >
              <span className="nav-item__icon">{v.icon}</span>
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
              <span className="nav-item__icon">⚙</span>
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
        <span className="nav-item__icon">🗀</span>
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

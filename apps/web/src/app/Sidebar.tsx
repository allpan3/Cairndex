import { useMemo, useState } from 'react'

import type { FolderRead, SmartFolderRead, ViewCounts } from '../api/client'
import { SYSTEM_VIEWS, type Selection } from './types'

interface SidebarProps {
  selection: Selection
  onSelect: (selection: Selection) => void
  counts?: ViewCounts
  folders: FolderRead[]
  folderCounts?: Record<string, number>
  smartFolders: SmartFolderRead[]
  onNewSmartFolder: () => void
  onEditSmartFolder: (sf: SmartFolderRead) => void
  onImport: () => void
}

interface TreeNode {
  folder: FolderRead
  children: TreeNode[]
}

function buildTree(folders: FolderRead[]): TreeNode[] {
  const byParent = new Map<string | null, FolderRead[]>()
  for (const f of folders) {
    const key = f.parent_id ?? null
    const list = byParent.get(key) ?? []
    list.push(f)
    byParent.set(key, list)
  }
  const make = (parent: string | null): TreeNode[] =>
    (byParent.get(parent) ?? [])
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((folder) => ({ folder, children: make(folder.id) }))
  return make(null)
}

export function Sidebar({
  selection,
  onSelect,
  counts,
  folders,
  folderCounts,
  smartFolders,
  onNewSmartFolder,
  onEditSmartFolder,
  onImport,
}: SidebarProps) {
  const tree = useMemo(() => buildTree(folders), [folders])

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
          const active = selection.folderId === null && selection.view === v.view
          return (
            <button
              key={v.view}
              className={`nav-item${active ? ' nav-item--active' : ''}`}
              onClick={() => onSelect({ view: v.view, folderId: null })}
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
          Smart Folders
          <button className="sidebar__add" onClick={onNewSmartFolder} aria-label="New smart folder">
            +
          </button>
        </div>
        {smartFolders.map((sf) => {
          const active = selection.smartFolderId === sf.id
          return (
            <div
              key={sf.id}
              className={`nav-item${active ? ' nav-item--active' : ''}`}
              onClick={() => onSelect({ view: 'all', folderId: null, smartFolderId: sf.id })}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ')
                  onSelect({ view: 'all', folderId: null, smartFolderId: sf.id })
              }}
            >
              <span className="nav-item__icon">⚙</span>
              <span className="nav-item__label">{sf.name}</span>
              <button
                className="nav-item__edit"
                onClick={(e) => {
                  e.stopPropagation()
                  onEditSmartFolder(sf)
                }}
                aria-label={`Edit ${sf.name}`}
              >
                ✎
              </button>
            </div>
          )
        })}
      </div>

      <div className="sidebar__section">
        <div className="sidebar__heading">Folders</div>
        {tree.length === 0 && <div className="sidebar__heading">No folders yet</div>}
        {tree.map((node) => (
          <FolderBranch
            key={node.folder.id}
            node={node}
            depth={0}
            selection={selection}
            onSelect={onSelect}
            folderCounts={folderCounts}
          />
        ))}
      </div>
    </aside>
  )
}

function FolderBranch({
  node,
  depth,
  selection,
  onSelect,
  folderCounts,
}: {
  node: TreeNode
  depth: number
  selection: Selection
  onSelect: (selection: Selection) => void
  folderCounts?: Record<string, number>
}) {
  const [expanded, setExpanded] = useState(depth < 1)
  const active = selection.folderId === node.folder.id
  const hasChildren = node.children.length > 0

  return (
    <>
      <div
        className={`nav-item folder-row${active ? ' nav-item--active' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => onSelect({ view: 'all', folderId: node.folder.id })}
        role="treeitem"
        aria-selected={active}
      >
        <button
          className="folder-row__toggle"
          onClick={(e) => {
            e.stopPropagation()
            setExpanded((v) => !v)
          }}
          aria-label={expanded ? 'Collapse' : 'Expand'}
        >
          {hasChildren ? (expanded ? '▾' : '▸') : ''}
        </button>
        <span className="nav-item__icon">🗀</span>
        <span className="nav-item__label">{node.folder.name}</span>
        <span className="nav-item__count">{folderCounts?.[node.folder.id] ?? ''}</span>
      </div>
      {expanded &&
        node.children.map((child) => (
          <FolderBranch
            key={child.folder.id}
            node={child}
            depth={depth + 1}
            selection={selection}
            onSelect={onSelect}
            folderCounts={folderCounts}
          />
        ))}
    </>
  )
}

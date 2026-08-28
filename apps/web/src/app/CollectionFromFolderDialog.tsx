import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'

import type { CollectionRead } from '../api/client'
import {
  useCollections,
  useCreateCollectionFromDirectory,
  useDirectoryBundleCount,
} from '../api/hooks'
import { PickGuides } from './PickGuides'
import { usePinyinSearch } from './pinyin'
import { flattenHierarchy, visibleHierarchy } from './usePopover'

/**
 * Make a collection out of a File Browser folder (owner, 2026-08-26).
 *
 * Collections stay logical (AGENTS.md §4.7): the folder is read to decide which
 * bundles join, and nothing on disk moves. What joins is every **confirmed**
 * bundle holding a file in that folder *or beneath it* — the subtree, because
 * "the collection for this folder" means everything filed under it, and a
 * collection is flat rather than mirroring the directory tree. Provisional
 * scan-staged bundles stay out; browse hides them from collections anyway.
 *
 * The count is fetched up front so the button can say what it will do. That is
 * the difference between a confident action and a surprise: the same click may
 * file two bundles or two hundred, and only the folder knows which.
 */
export function CollectionFromFolderDialog({
  directory,
  onClose,
  onCreated,
}: {
  /** Library-relative folder the collection is made from. */
  directory: string
  onClose: () => void
  onCreated: (collection: CollectionRead, bundlesAdded: number) => void
}) {
  const folderName = directory.split('/').pop() ?? directory
  const [name, setName] = useState(folderName)
  const [parentId, setParentId] = useState<string | null>(null)
  const { data: collections = [] } = useCollections()
  const [parentSearch, setParentSearch] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const matchName = usePinyinSearch(parentSearch)
  const { data: bundleCount, isLoading: counting } = useDirectoryBundleCount(directory)
  const create = useCreateCollectionFromDirectory()
  const trimmed = name.trim()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  // The parent tree, foldable. A native <select> cannot fold, and a flat list of
  // every collection in a library is unusable once there are many (owner,
  // 2026-08-28): depth is only legible while you can close what you are not
  // looking at. Same shape as the bundle inspector's collection picker — a
  // depth-first walk with guide rails and a chevron.
  const rows = useMemo(() => {
    if (parentSearch.trim()) {
      // Flattened while searching, so a match is never hidden inside a folded
      // branch. That is the one case where keeping the tree would lose the
      // answer the search just found.
      return flattenHierarchy(collections)
        .filter(({ item }) => matchName(item.name))
        .map(({ item }) => ({ item, depth: 0, hasChildren: false }))
    }
    return visibleHierarchy(collections, collapsed)
  }, [collections, collapsed, parentSearch, matchName])

  const toggleFold = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const submit = () => {
    if (!trimmed || create.isPending) return
    create.mutate(
      { directory, name: trimmed, parent_id: parentId },
      {
        onSuccess: (result) => onCreated(result.collection, result.bundles_added),
        // Stays open on failure: a name already taken under the chosen parent is
        // answered by editing the name, and closing would throw away both it and
        // the parent choice.
      },
    )
  }

  const willAdd =
    counting || bundleCount === undefined
      ? 'Counting the bundles in this folder…'
      : bundleCount === 0
        ? 'No bundles in this folder yet — the collection starts empty.'
        : bundleCount === 1
          ? 'The 1 bundle in this folder joins it.'
          : `The ${bundleCount} bundles in this folder and below join it.`

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal modal--confirm"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="New Collection from Folder"
      >
        <div className="modal__head">
          <h2>New Collection from “{folderName}”</h2>
          <button className="modal__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <label className="field-label" htmlFor="cff-name">
          Name
        </label>
        <input
          id="cff-name"
          className="edit"
          value={name}
          autoFocus
          spellCheck={false}
          onFocus={(e) => e.target.select()}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            e.preventDefault()
            submit()
          }}
        />

        <label className="field-label" htmlFor="cff-parent-search">
          Inside
        </label>
        <input
          id="cff-parent-search"
          className="edit"
          type="search"
          placeholder="Search collections…"
          value={parentSearch}
          spellCheck={false}
          onChange={(e) => setParentSearch(e.target.value)}
        />
        {/* Radios, not tick boxes: exactly one parent is chosen, and a tick box
            reads as "any number of these" (owner, 2026-08-28).

            Rows are real buttons rather than clickable divs — this is a form
            field in a modal, so it has to be reachable and operable from the
            keyboard, and a button gets focus, Enter and Space for free. */}
        <div className="cff-tree" role="radiogroup" aria-label="Parent collection">
          <button
            type="button"
            className={`pick-row${parentId === null ? ' pick-row--on' : ''}`}
            role="radio"
            aria-checked={parentId === null}
            onClick={() => setParentId(null)}
          >
            <span className={`pick-row__radio${parentId === null ? ' pick-row__radio--on' : ''}`} />
            <span className="pick-row__name">Top level</span>
          </button>
          {rows.map(({ item, depth, hasChildren }) => {
            const on = parentId === item.id
            return (
              <div className="cff-tree__row" key={item.id}>
                <button
                  type="button"
                  className={`pick-row${on ? ' pick-row--on' : ''}`}
                  role="radio"
                  aria-checked={on}
                  onClick={() => setParentId(item.id)}
                >
                  <PickGuides depth={depth} />
                  <span className={`pick-row__radio${on ? ' pick-row__radio--on' : ''}`} />
                  <span className="pick-row__name">{item.name}</span>
                </button>
                {/* Sibling rather than nested: a button inside a button is
                    invalid, and the fold is a separate action from choosing. */}
                {hasChildren ? (
                  <button
                    type="button"
                    className="pick-row__toggle"
                    onClick={() => toggleFold(item.id)}
                    aria-expanded={!collapsed.has(item.id)}
                    aria-label={`${collapsed.has(item.id) ? 'Expand' : 'Collapse'} ${item.name}`}
                  >
                    {collapsed.has(item.id) ? '›' : '⌄'}
                  </button>
                ) : (
                  <span className="pick-row__toggle" aria-hidden="true" />
                )}
              </div>
            )
          })}
          {rows.length === 0 && parentSearch.trim() && (
            <p className="dir-picker__empty">No collection matches “{parentSearch.trim()}”.</p>
          )}
        </div>

        <p className="lib-add__hint">
          {willAdd} Nothing on disk moves — a collection is a grouping, not a folder.
        </p>

        {create.isError && (
          <p className="dir-picker__error" role="alert">
            {create.error instanceof Error
              ? create.error.message
              : 'That collection could not be created.'}
          </p>
        )}

        <div className="modal__actions">
          <span className="toolbar__spacer" />
          <button className="btn" onClick={onClose} disabled={create.isPending}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            disabled={!trimmed || create.isPending}
            onClick={submit}
          >
            {create.isPending ? 'Creating…' : 'Create Collection'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

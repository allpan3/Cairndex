import { useState } from 'react'
import { createPortal } from 'react-dom'

import type { BundleSummary } from '../api/client'
import {
  useBatchUpdate,
  useBulkUpdateBundles,
  useCollections,
  useCommonBundleCollections,
  useCommonBundleTags,
  useCreateCollection,
  useCreateTagPath,
  useTags,
} from '../api/hooks'
import { formatBytes } from '../lib/format'
import { StarRating } from './Stars'
import { usePinyinSearch } from './pinyin'
import { flattenHierarchy, usePopover } from './usePopover'

/** A flat checkbox-style multi-pick list, shared by the bulk tag and
 * collection pickers below. Unlike the single-bundle editors (TagEditor,
 * CollectionPicker), toggling here adds/removes the item across every
 * selected bundle via the batch endpoint rather than replacing one bundle's
 * full set — each bundle keeps whatever else it already had. */
function BulkPicker({
  label,
  placeholder,
  rows,
  assigned,
  onToggle,
  onCreate,
}: {
  label: string
  placeholder: string
  rows: { item: { id: string; name: string }; depth: number }[]
  assigned: Set<string>
  onToggle: (id: string) => void
  // Called with the trimmed search text when the picker offers "Create …"
  // (shown whenever the search doesn't exactly name an existing row).
  onCreate: (name: string) => void
}) {
  const { open, setOpen, ref, panelRef, pos } = usePopover()
  const [search, setSearch] = useState('')
  const matchSearch = usePinyinSearch(search)
  const trimmedSearch = search.trim()
  const visible = rows.filter(({ item }) => matchSearch(item.name))
  // "Create <search>" offers a *new* item with this exact name — shown
  // whenever the search doesn't already name an existing row exactly, even if
  // it's a substring of one.
  const hasExactMatch = rows.some(
    ({ item }) => item.name.toLowerCase() === trimmedSearch.toLowerCase(),
  )
  return (
    <div className="picker" ref={ref}>
      <button className="add-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {label}
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            className="picker__panel"
            ref={panelRef}
            style={{
              top: pos.top,
              bottom: pos.bottom,
              right: pos.right,
              maxHeight: pos.maxHeight,
            }}
          >
            <input
              className="edit picker__search"
              placeholder={placeholder}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              // Enter takes the obvious action: the one match when the search
              // narrows to a single row, otherwise create what was typed. The
              // field clears either way so the next one can be typed straight
              // in (owner, 2026-07-27).
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || !trimmedSearch) return
                e.preventDefault()
                const exact = visible.find(
                  ({ item }) => item.name.toLowerCase() === trimmedSearch.toLowerCase(),
                )
                const chosen = exact ?? (visible.length === 1 ? visible[0] : undefined)
                if (chosen) onToggle(chosen.item.id)
                else onCreate(trimmedSearch)
                setSearch('')
              }}
              autoFocus
              aria-label={placeholder}
            />
            {visible.length === 0 && trimmedSearch === '' && (
              <div className="pick-group">No matches</div>
            )}
            {visible.map(({ item, depth }) => {
              const on = assigned.has(item.id)
              return (
                <div
                  key={item.id}
                  className={`pick-row${on ? ' pick-row--on' : ''}`}
                  style={{ paddingLeft: 8 + depth * 14 }}
                  onClick={() => onToggle(item.id)}
                  role="option"
                  aria-selected={on}
                >
                  <span className={`pick-row__box${on ? ' pick-row__box--on' : ''}`}>
                    {on ? '✓' : ''}
                  </span>
                  <span className="pick-row__name">{item.name}</span>
                </div>
              )
            })}
            {trimmedSearch !== '' && !hasExactMatch && (
              <div
                className="pick-row pick-row--create"
                onClick={() => {
                  onCreate(trimmedSearch)
                  setSearch('')
                }}
                role="option"
                aria-selected={false}
              >
                <span className="pick-row__create-icon">+</span>
                <span className="pick-row__name">Create &ldquo;{trimmedSearch}&rdquo;</span>
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  )
}

/**
 * Right-panel editor for a multi-bundle selection (replaces the old top
 * "batch bar"). Title overwrites every selected bundle; rating shows the
 * shared value (or unset when they differ) and likewise overwrites all on
 * change; tags/collections common to every selected bundle show as assigned,
 * and toggling one adds/removes it across the whole selection. No note field
 * — a note is inherently per-bundle prose, not something to overwrite in bulk.
 */
export function MultiBundleInspector({
  ids,
  items,
  onClear,
}: {
  ids: string[]
  items: BundleSummary[]
  onClear: () => void
}) {
  const { data: tags = [] } = useTags()
  const { data: collections = [] } = useCollections()
  const { commonTagIds } = useCommonBundleTags(ids)
  const { commonCollectionIds } = useCommonBundleCollections(ids)
  const bulkUpdate = useBulkUpdateBundles()
  const batch = useBatchUpdate()
  const createTag = useCreateTagPath()
  const createCollection = useCreateCollection()
  const [title, setTitle] = useState('')

  const totalFiles = items.reduce((s, i) => s + i.file_count, 0)
  const totalSize = items.reduce((s, i) => s + i.total_size, 0)
  const ratings = new Set(items.map((i) => i.rating ?? 0))
  const commonRating = ratings.size === 1 ? ([...ratings][0] ?? 0) : 0

  const commitTitle = () => {
    const trimmed = title.trim()
    if (!trimmed) return
    bulkUpdate.mutate({ ids, patch: { title: trimmed } })
    setTitle('')
  }

  const toggleTag = (tagId: string) => {
    if (commonTagIds.has(tagId)) batch.mutate({ bundle_ids: ids, remove_tag_ids: [tagId] })
    else batch.mutate({ bundle_ids: ids, add_tag_ids: [tagId] })
  }
  const toggleCollection = (collectionId: string) => {
    if (commonCollectionIds.has(collectionId))
      batch.mutate({ bundle_ids: ids, remove_collection_ids: [collectionId] })
    else batch.mutate({ bundle_ids: ids, add_collection_ids: [collectionId] })
  }

  // "Create <search>" in either picker: make a new top-level tag/collection
  // and add it to every selected bundle.
  const handleCreateTag = (name: string) => {
    createTag.mutate(
      // `/` nests: `genre/noir` creates (or reuses) `genre`, `noir` under it.
      { path: name, existing: tags },
      { onSuccess: (created) => batch.mutate({ bundle_ids: ids, add_tag_ids: [created.id] }) },
    )
  }
  const handleCreateCollection = (name: string) => {
    createCollection.mutate(
      { name, parent_id: null },
      {
        onSuccess: (created) => batch.mutate({ bundle_ids: ids, add_collection_ids: [created.id] }),
      },
    )
  }

  const tagById = new Map(tags.map((t) => [t.id, t]))
  const collectionById = new Map(collections.map((c) => [c.id, c]))

  return (
    <aside className="inspector" data-tauri-drag-region>
      <div className="inspector__multi-head">
        <span>{ids.length} bundles selected</span>
        <button className="add-btn" onClick={onClear}>
          Clear
        </button>
      </div>

      <input
        className="edit edit--title"
        value={title}
        placeholder="Multiple titles — type to rename all"
        onChange={(e) => setTitle(e.target.value)}
        onBlur={commitTitle}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
        aria-label="Title"
      />

      <div className="prop">
        <span className="prop__k">Rating</span>
        <StarRating
          value={commonRating}
          onChange={(v) => bulkUpdate.mutate({ ids, patch: { rating: v === 0 ? null : v } })}
        />
      </div>
      <div className="prop">
        <span className="prop__k">Files</span>
        <span className="prop__v">{totalFiles}</span>
      </div>
      <div className="prop">
        <span className="prop__k">Size</span>
        <span className="prop__v">{formatBytes(totalSize)}</span>
      </div>

      <label className="field-label">Tags</label>
      <div className="chips">
        {[...commonTagIds]
          .map((id) => tagById.get(id))
          .filter((t) => t !== undefined)
          .map((t) => (
            <span className="chip" key={t.id}>
              {t.name}
              <button onClick={() => toggleTag(t.id)} aria-label={`Remove ${t.name}`}>
                ×
              </button>
            </span>
          ))}
        <BulkPicker
          label="+ Tag"
          placeholder="Search tags…"
          rows={flattenHierarchy(tags)}
          assigned={commonTagIds}
          onToggle={toggleTag}
          onCreate={handleCreateTag}
        />
      </div>

      <label className="field-label">Collections</label>
      <div className="chips">
        {[...commonCollectionIds]
          .map((id) => collectionById.get(id))
          .filter((c) => c !== undefined)
          .map((c) => (
            <span className="chip" key={c.id}>
              {c.name}
              <button onClick={() => toggleCollection(c.id)} aria-label={`Remove from ${c.name}`}>
                ×
              </button>
            </span>
          ))}
        <BulkPicker
          label="+ Collection"
          placeholder="Search collections…"
          rows={flattenHierarchy(collections)}
          assigned={commonCollectionIds}
          onToggle={toggleCollection}
          onCreate={handleCreateCollection}
        />
      </div>
    </aside>
  )
}

import { useMetadataDraft } from '../state/useMetadataDraft'
import { useState } from 'react'

import type { CollectionRead } from '../api/client'
import { collectionThumbnailUrl } from '../api/client'
import { useCollectionStats, useUpdateCollection } from '../api/hooks'
import { OverlayScrollbar } from './OverlayScrollbar'

/**
 * Right-pane details for a selected collection (single-click a collection card).
 * Editable title + description, plus counts: bundles directly in this collection,
 * total bundles across the whole subtree, and direct subcollections. Shows the
 * cover (chosen via "Set as collection cover", else auto-picked) when present.
 */
export function CollectionInspector({ collection }: { collection: CollectionRead }) {
  // Keyed by id in the parent so drafts re-initialize when the selection changes.
  const stats = useCollectionStats(collection.id)
  const update = useUpdateCollection()
  const nameDraft = useMetadataDraft(
    `collection:${collection.id}:name`,
    collection.name,
    collection,
  )
  const noteDraft = useMetadataDraft(
    `collection:${collection.id}:note`,
    collection.note ?? '',
    collection,
  )
  const name = nameDraft.value
  const note = noteDraft.value
  const setName = nameDraft.change
  const setNote = noteDraft.change
  // Tracked against the URL rather than latched once — see `CollectionCard` for
  // why a plain boolean left the cover missing for good after one 404.
  const coverSrc = collectionThumbnailUrl(collection.id, collection.updated_at)
  const [failedCoverSrc, setFailedCoverSrc] = useState<string | null>(null)
  const hasCover = failedCoverSrc !== coverSrc

  const commitName = () => {
    const trimmed = name.trim()
    if (trimmed === '' || trimmed === collection.name) {
      setName(collection.name)
      return
    }
    update.mutate(nameDraft.bind({ id: collection.id, patch: { name: trimmed } }), {
      onSuccess: () => nameDraft.saved(name),
    })
  }
  const commitNote = () => {
    if (note === (collection.note ?? '')) return
    update.mutate(noteDraft.bind({ id: collection.id, patch: { note: note.trim() || null } }), {
      onSuccess: () => noteDraft.saved(note),
    })
  }

  return (
    <aside className="inspector" data-tauri-drag-region>
      <OverlayScrollbar />
      {hasCover && (
        <div className="inspector__cover">
          <img
            src={coverSrc}
            alt=""
            draggable={false}
            onError={() => setFailedCoverSrc(coverSrc)}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        </div>
      )}

      {(nameDraft.error || noteDraft.error) && (
        <p role="alert">{nameDraft.error || noteDraft.error}</p>
      )}
      <input
        className="edit edit--title"
        value={name}
        placeholder="Untitled collection"
        onFocus={nameDraft.begin}
        onChange={(e) => setName(e.target.value)}
        onBlur={commitName}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
        aria-label="Collection title"
      />

      {/* "Description" rather than "Note": it describes the collection, and the
          owner asked for it by that name (2026-07-27). Same column position and
          box as a bundle's notes, so the two rails read alike. */}
      <div className="notes-head">
        <label className="field-label">Description</label>
      </div>
      <textarea
        className="edit edit--note"
        value={note}
        placeholder="Describe this collection…"
        onFocus={noteDraft.begin}
        onChange={(e) => setNote(e.target.value)}
        onBlur={commitNote}
        aria-label="Collection description"
        rows={4}
      />

      <div className="prop">
        <span className="prop__k">Bundles (here)</span>
        <span className="prop__v">{stats.data?.direct_bundles ?? '—'}</span>
      </div>
      <div className="prop">
        <span className="prop__k">Bundles (total)</span>
        <span className="prop__v">{stats.data?.total_bundles ?? '—'}</span>
      </div>
      <div className="prop">
        <span className="prop__k">Subcollections</span>
        <span className="prop__v">{stats.data?.subcollections ?? '—'}</span>
      </div>
    </aside>
  )
}

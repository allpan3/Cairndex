import { useState } from 'react'

import type { CollectionRead } from '../api/client'
import { collectionThumbnailUrl } from '../api/client'
import { useCollectionStats, useUpdateCollection } from '../api/hooks'

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
  const [name, setName] = useState(collection.name)
  const [note, setNote] = useState(collection.note ?? '')
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
    update.mutate({ id: collection.id, patch: { name: trimmed }, version: collection.version })
  }
  const commitNote = () => {
    if (note === (collection.note ?? '')) return
    update.mutate({
      id: collection.id,
      patch: { note: note.trim() || null },
      version: collection.version,
    })
  }

  return (
    <aside className="inspector" data-tauri-drag-region>
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

      <input
        className="edit edit--title"
        value={name}
        placeholder="Untitled collection"
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

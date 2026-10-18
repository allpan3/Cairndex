import { useState } from 'react'
import { collectionThumbnailUrl } from '../api/client'
import { describeCollection, rename } from '../api/catalogOrganize'
import { OverlayScrollbar } from './OverlayScrollbar'
import type { CatalogCollection, CatalogCollections } from './useCatalogCollections'

/**
 * A selected or open collection, as v0.2.1's collection inspector showed it: its
 * cover, an editable name and description, and its counts. Each field saves on
 * blur through the catalog, so a change made elsewhere is refused for review.
 */
export function CatalogCollectionInspector({
  library,
  collection,
  subcollections,
  collections,
  editable,
}: {
  library: string
  collection: CatalogCollection
  subcollections: number
  collections: CatalogCollections
  editable: boolean
}) {
  // A draft exists only while its field has focus, so remote changes show at rest
  const [name, setName] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const coverSrc = collectionThumbnailUrl(
    collection.id,
    [collection.updated_at, collection.cover_bundle_id, collection.count].join(':'),
  )
  const [failedCover, setFailedCover] = useState<string | null>(null)
  // The draft stays on screen until the refreshed collection replaces it
  const commitName = () => {
    const next = name?.trim() ?? ''
    if (!next || next === collection.name) return setName(null)
    const clear = () => setName(null)
    collections.run(() => rename(library, 'collections', collection.id, next), clear, clear)
  }
  const commitNote = () => {
    const next = note ?? ''
    if (next.trim() === (collection.note ?? '').trim()) return setNote(null)
    const clear = () => setNote(null)
    collections.run(() => describeCollection(library, collection.id, next), clear, clear)
  }
  return (
    <aside className="inspector" aria-label="Collection inspector" data-tauri-drag-region>
      <OverlayScrollbar />
      {failedCover !== coverSrc && (
        <div className="inspector__cover">
          <img
            src={coverSrc}
            alt=""
            draggable={false}
            onError={() => setFailedCover(coverSrc)}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        </div>
      )}
      <input
        className="edit edit--title"
        value={name ?? collection.name}
        placeholder="Untitled collection"
        readOnly={!editable}
        onFocus={() => editable && setName(collection.name)}
        onChange={(event) => setName(event.target.value)}
        onBlur={commitName}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
          if (event.key === 'Escape') {
            setName(collection.name)
            event.currentTarget.blur()
          }
        }}
        aria-label="Collection title"
      />
      <div className="notes-head">
        <label className="field-label" htmlFor="catalog-collection-note">
          Description
        </label>
      </div>
      <textarea
        id="catalog-collection-note"
        className="edit edit--note"
        value={note ?? collection.note ?? ''}
        placeholder="Describe this collection…"
        readOnly={!editable}
        onFocus={() => editable && setNote(collection.note ?? '')}
        onChange={(event) => setNote(event.target.value)}
        onBlur={commitNote}
        rows={4}
      />
      <div className="prop">
        <span className="prop__k">Bundles (here)</span>
        <span className="prop__v">{collection.direct_count ?? '—'}</span>
      </div>
      <div className="prop">
        <span className="prop__k">Bundles (total)</span>
        <span className="prop__v">{collection.count}</span>
      </div>
      <div className="prop">
        <span className="prop__k">Subcollections</span>
        <span className="prop__v">{subcollections}</span>
      </div>
    </aside>
  )
}

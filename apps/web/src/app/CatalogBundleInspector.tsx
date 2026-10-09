import { useState } from 'react'
import type { Entity } from '../api/catalog'
import { BundleTitleEditor, NoteBox } from './Inspector'
import { InspectorSection } from './InspectorSection'
import { StarRating } from './Stars'
import { IconPlus } from './icons'
import { useCatalogBundleDraft } from './useCatalogBundleDraft'
import { thumbnailUrl, fileThumbnailUrl } from '../api/client'
import { CatalogMembershipPicker } from './CatalogMembershipPicker'
import { CatalogFileDetails } from './CatalogFileDetails'
import { CatalogBundleFiles } from './CatalogBundleFiles'

// The normal inspector controls use causal requests, never legacy metadata mutations.
export function CatalogBundleInspector({
  library,
  entity,
  editor,
  inspectorEnabled,
  blocked,
  refresh,
  onReview,
  onOpen,
  onOpenFile,
  onAlbum,
  albumFile,
}: {
  library: string
  entity: Entity
  editor: string
  inspectorEnabled: boolean
  blocked: boolean
  refresh: () => void
  onReview: () => void
  onOpen: () => void
  onOpenFile: (file: string) => void
  onAlbum?: () => void
  albumFile?: string | null
}) {
  const draft = useCatalogBundleDraft(library, entity, editor, refresh)
  const [heights, setHeights] = useState<Record<number, number | null>>({})
  const title = JSON.parse(draft.read('title')) as string | null
  const rating = JSON.parse(draft.read('rating')) as number | null
  const cover = JSON.parse(draft.read('cover_file_id')) as string | null
  const [coverFailed, setCoverFailed] = useState('')
  const coverUrl = cover
    ? fileThumbnailUrl(entity.id, cover, cover)
    : thumbnailUrl(entity.id, entity.fields.cover_file_id?.basis.join(':'))
  const notesText = JSON.parse(draft.read('notes')) as string | null
  const savedNotes = (notesText ? JSON.parse(notesText) : []) as string[] | null
  const notes = savedNotes?.length ? savedNotes : ['']
  const setNotes = (value: string[]) => draft.change('notes', JSON.stringify(JSON.stringify(value)))
  const move = (index: number, delta: number) => {
    const next = [...notes]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target]!, next[index]!]
    setNotes(next)
  }
  return (
    <aside className="inspector" aria-label="Bundle inspector">
      <div className="catalog-inspector-cover">
        {inspectorEnabled &&
          (coverFailed !== coverUrl ? (
            <img src={coverUrl} alt="Bundle cover" onError={() => setCoverFailed(coverUrl)} />
          ) : (
            <p>Cover unavailable on this device.</p>
          ))}
        <button onClick={onOpen}>Open media on this device</button>
        {inspectorEnabled && coverFailed === coverUrl && (
          <button onClick={() => setCoverFailed('')}>Retry cover</button>
        )}
      </div>
      {onAlbum && <button onClick={onAlbum}>Browse bundle files</button>}
      {albumFile && <CatalogFileDetails key={albumFile} library={library} file={albumFile} />}
      <p role="status">{draft.message}</p>
      {draft.error && <p role="alert">{draft.error}</p>}
      {entity.has_conflicts && <p role="alert">Competing metadata requires review.</p>}
      <BundleTitleEditor
        value={title ?? ''}
        onChange={(value) => draft.change('title', JSON.stringify(value || null))}
        onBegin={() => {
          if (!draft.draft.inputs[entity.fields.title!.unit])
            draft.change('title', JSON.stringify(title))
        }}
        onCommit={() => {}}
      />
      <div className="prop">
        <span className="prop__k">Rating</span>
        <StarRating
          value={rating ?? 0}
          onChange={(value) => draft.change('rating', JSON.stringify(value || null))}
        />
      </div>
      <InspectorSection
        id="notes"
        title="Notes"
        actions={
          <button
            className="notes-add"
            aria-label="Add note"
            onClick={() => setNotes([...notes, ''])}
          >
            <IconPlus />
          </button>
        }
      >
        <div
          className="notes-list"
          onFocus={() => {
            if (!draft.draft.inputs[entity.fields.notes!.unit]) setNotes(notes)
          }}
        >
          {notes.map((note, index) => (
            <NoteBox
              keyboardReorderOnly
              key={index}
              value={note}
              index={index}
              count={notes.length}
              height={heights[index] ?? null}
              onChange={(value) => setNotes(notes.map((old, at) => (at === index ? value : old)))}
              onCommit={() => {}}
              onRemove={() => setNotes(notes.filter((_, at) => at !== index))}
              onResize={(height) => setHeights({ ...heights, [index]: height })}
              dragging={false}
              onDragStart={() => {}}
              onDragMove={() => {}}
              onDragEnd={() => {}}
              onMoveBy={(delta) => move(index, delta)}
            />
          ))}
        </div>
      </InspectorSection>
      <button
        className="btn"
        disabled={
          blocked || draft.busy || (!draft.draft.pending && !Object.keys(draft.draft.inputs).length)
        }
        onClick={() => void draft.save()}
      >
        {draft.draft.pending && !draft.busy ? 'Retry save' : 'Save changes'}
      </button>
      <button
        className="btn"
        disabled={draft.busy || Boolean(draft.draft.pending)}
        onClick={() => void draft.discard()}
      >
        Discard draft
      </button>
      {draft.copies.map((copy) => (
        <button
          className="btn"
          key={copy.id}
          disabled={draft.busy || Boolean(draft.draft.pending)}
          onClick={() => draft.recover(copy.body.data)}
        >
          Recover private draft {copy.revision}
        </button>
      ))}

      {inspectorEnabled &&
        (['tags', 'collections'] as const).map((family) => (
          <CatalogMembershipPicker
            key={family}
            library={library}
            bundle={entity.id}
            editor={editor}
            family={family}
            blocked={blocked}
            onReview={onReview}
          />
        ))}
      {inspectorEnabled && (
        <CatalogBundleFiles
          library={library}
          bundle={entity.id}
          cover={cover}
          blocked={blocked || draft.busy}
          onCover={(file, reference) =>
            draft.change('cover_file_id', JSON.stringify(file), reference ? [reference] : [])
          }
          onOpen={onOpenFile}
        />
      )}
      {!inspectorEnabled && (
        <p>Additional inspector controls require a server update. Use Metadata review.</p>
      )}
      <button className="btn" onClick={onReview}>
        Review metadata and conflicts
      </button>
      <p>
        File order, structural changes and history use metadata review. Source file operations are
        unavailable.
      </p>
    </aside>
  )
}

import type { LibraryHostFiles } from '../desktop/useLibraryHostFiles'
import { useState, type ReactNode } from 'react'
import type { Entity } from '../api/catalog'
import { BundleTitleEditor, NoteBox } from './Inspector'
import { InspectorSection } from './InspectorSection'
import { StarRating } from './Stars'
import { IconPlus } from './icons'
import { useCatalogBundleDraft } from './useCatalogBundleDraft'
import { thumbnailUrl, fileThumbnailUrl } from '../api/client'
import { formatDate } from '../lib/format'
import { CatalogBundleMemberships } from './CatalogBundleMemberships'
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
  hostFiles,
  onStartBundleDrag,
  onSelectHostFile,
  onOpenFile,
  moments,
  albumFile,
  onAddFiles,
  summary,
  onOpenCollection,
}: {
  hostFiles?: LibraryHostFiles
  onStartBundleDrag?: () => void
  onSelectHostFile?: (file: string | null) => void
  library: string
  entity: Entity
  editor: string
  inspectorEnabled: boolean
  blocked: boolean
  refresh: () => void
  onReview: () => void
  /** Open the bundle in the viewer; absent inside the viewer itself. */
  onOpen?: () => void
  onOpenFile: (file: string) => void
  /** The moments section; each surface supplies its own source and actions. */
  moments?: ReactNode
  albumFile?: string | null
  /** Add Unbundled files to this confirmed bundle. */
  onAddFiles?: () => void
  /** The browser's card for this bundle, for the facts the entity does not carry. */
  summary?: { file_count: number; date_added: string }
  onOpenCollection?: (id: string) => void
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
  const unsaved = Boolean(draft.draft.pending) || Object.keys(draft.draft.inputs).length > 0
  const move = (index: number, delta: number) => {
    const next = [...notes]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target]!, next[index]!]
    setNotes(next)
  }
  // The footer appears once there is something to save, recover or report
  const footer = unsaved || draft.busy || draft.copies.length > 0 || Boolean(draft.message)
  return (
    <aside className="inspector" aria-label="Bundle inspector">
      <div
        className="inspector__cover catalog-inspector-cover"
        draggable={Boolean(onStartBundleDrag)}
        onDragStart={(event) => {
          event.preventDefault()
          onStartBundleDrag?.()
        }}
      >
        {inspectorEnabled &&
          (coverFailed !== coverUrl ? (
            <img src={coverUrl} alt="Bundle cover" onError={() => setCoverFailed(coverUrl)} />
          ) : (
            <span className="catalog-inspector-cover__note">
              Cover unavailable on this device.{' '}
              <button className="btn btn--sm" onClick={() => setCoverFailed('')}>
                Try Again
              </button>
            </span>
          ))}
        {onOpen && (
          <button className="inspector__play" onClick={onOpen} aria-label="Play" title="Play">
            ▶
          </button>
        )}
      </div>
      {albumFile && (
        <CatalogFileDetails
          key={albumFile}
          library={library}
          file={albumFile}
          hostFiles={hostFiles}
        />
      )}
      {draft.error && <p role="alert">{draft.error}</p>}
      {entity.has_conflicts && (
        <p className="catalog-inspector-conflict" role="alert">
          <span>Competing metadata requires review.</span>{' '}
          <button className="btn btn--sm" onClick={onReview}>
            Review Conflicts
          </button>
        </p>
      )}
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
      {summary && (
        <>
          <div className="prop">
            <span className="prop__k">Files</span>
            <span className="prop__v">{summary.file_count}</span>
          </div>
          <div className="prop">
            <span className="prop__k">Date Added</span>
            <span className="prop__v">{formatDate(summary.date_added)}</span>
          </div>
        </>
      )}
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
      {inspectorEnabled &&
        (['tags', 'collections'] as const).map((family) => (
          <CatalogBundleMemberships
            key={family}
            library={library}
            ids={[entity.id]}
            family={family}
            blocked={blocked}
            onReview={onReview}
            onOpenCollection={onOpenCollection}
          />
        ))}
      {inspectorEnabled && moments}
      {inspectorEnabled && (
        <CatalogBundleFiles
          library={library}
          bundle={entity.id}
          cover={cover}
          blocked={blocked || draft.busy}
          fileCount={summary?.file_count}
          onCover={(file, reference) =>
            draft.change('cover_file_id', JSON.stringify(file), reference ? [reference] : [])
          }
          onOpen={onOpenFile}
          onAddFiles={onAddFiles}
          hostFiles={hostFiles}
          onSelectHostFile={onSelectHostFile}
        />
      )}
      {!inspectorEnabled && (
        <p>Additional inspector controls require a server update. Use Metadata review.</p>
      )}
      {/* A footer pinned to the inspector's bottom edge: in a short window the
          inspector scrolls, and Save must stay in view wherever it is scrolled.
          Edits wait here as a private draft until they are saved. */}
      {footer && (
        <div className="catalog-inspector-actions">
          <button
            className="btn"
            disabled={blocked || draft.busy || !unsaved}
            onClick={() => void draft.save()}
          >
            {draft.draft.pending && !draft.busy ? 'Retry save' : 'Save changes'}
          </button>
          <button
            className="btn"
            disabled={draft.busy || Boolean(draft.draft.pending) || !unsaved}
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
          <p role="status">{draft.message}</p>
        </div>
      )}
    </aside>
  )
}

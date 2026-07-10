import { useRef, useState } from 'react'

import { ConflictError, type BundleRead, thumbnailUrl } from '../api/client'
import { useBundle, useBundleFiles, useFileMutations, useUpdateBundle } from '../api/hooks'
import { formatBytes, formatDate, formatDimensions, formatDuration } from '../lib/format'
import { CollectionPicker } from './CollectionPicker'
import { TagEditor } from './TagEditor'

/** Shown when an edit was rejected because the bundle changed elsewhere
 * (ADR-0008 phase 9). The latest server values are already being refetched. */
function ConflictNotice({ error }: { error: unknown }) {
  if (!(error instanceof ConflictError)) return null
  return (
    <div className="conflict-notice" role="alert">
      This item was changed elsewhere, so your edit wasn’t applied. The latest values are shown
      below — save again to apply your change over them.
    </div>
  )
}

export function StarRating({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <span className="stars" role="radiogroup" aria-label="Rating">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          className="star-btn"
          aria-label={`${n} star${n > 1 ? 's' : ''}`}
          aria-pressed={n <= value}
          onClick={() => onChange(n === value ? 0 : n)} // clicking current rating clears it
        >
          {n <= value ? '★' : '☆'}
        </button>
      ))}
    </span>
  )
}

export function Inspector({
  bundleId,
  onAddFiles,
  onPlayBundle,
}: {
  bundleId: string | null
  /** Open the "Add files" manual bundling dialog for this bundle. */
  onAddFiles?: (bundleId: string) => void
  /** Open the unified media viewer for this bundle. */
  onPlayBundle?: (bundleId: string) => void
}) {
  const { data: bundle } = useBundle(bundleId)

  if (bundleId === null) {
    return (
      <aside className="inspector">
        <div className="state">Select a bundle or collection to see its details.</div>
      </aside>
    )
  }
  if (!bundle) {
    return (
      <aside className="inspector">
        <div className="state">Loading…</div>
      </aside>
    )
  }
  // Keyed by id so draft fields re-initialize when the selection changes
  // (no setState-in-effect needed).
  return (
    <BundleEditor
      key={bundle.id}
      bundle={bundle}
      onAddFiles={onAddFiles}
      onPlayBundle={onPlayBundle}
    />
  )
}

function BundleEditor({
  bundle,
  onAddFiles,
  onPlayBundle,
}: {
  bundle: BundleRead
  onAddFiles?: (bundleId: string) => void
  onPlayBundle?: (bundleId: string) => void
}) {
  const bundleId = bundle.id
  const { data: files = [] } = useBundleFiles(bundleId)
  const update = useUpdateBundle(bundleId, bundle.version)

  const [title, setTitle] = useState(bundle.title ?? '')
  // Multiple freeform notes; always keep at least one (empty) box so there is
  // something to type into and to append below with the "+" affordance.
  const [notes, setNotes] = useState<string[]>(
    bundle.notes && bundle.notes.length > 0 ? bundle.notes : [''],
  )
  // Mirror of ``notes`` kept synchronously current in the event handlers, so a
  // blur that lands in the same tick as the last keystroke still commits the
  // latest text (a plain render-closure could be one edit stale).
  const notesRef = useRef(notes)
  const applyNotes = (next: string[]) => {
    notesRef.current = next
    setNotes(next)
  }

  const hasVideo = files.some((f) => f.media_kind === 'video')

  const commitTitle = (value: string) => {
    if (value === (bundle.title ?? '')) return
    update.mutate({ title: value === '' ? null : value })
  }

  // Notes edit as a whole-list replace. Blank/whitespace-only blocks (an
  // untouched draft box) are dropped, and compared out here so blurring an empty
  // box never fires a redundant PATCH.
  const commitNotes = () => {
    const cleaned = notesRef.current.filter((n) => n.trim() !== '')
    const prev = (bundle.notes ?? []).filter((n) => n.trim() !== '')
    if (cleaned.length === prev.length && cleaned.every((n, i) => n === prev[i])) return
    update.mutate({ notes: cleaned })
  }
  const changeNote = (i: number, value: string) =>
    applyNotes(notesRef.current.map((n, j) => (j === i ? value : n)))
  const addNote = () => applyNotes([...notesRef.current, ''])
  const removeNote = (i: number) => {
    const next = notesRef.current.filter((_, j) => j !== i)
    applyNotes(next.length > 0 ? next : [''])
    commitNotes()
  }

  return (
    <aside className="inspector">
      <div
        className="inspector__cover"
        style={{ backgroundImage: `url(${thumbnailUrl(bundleId, bundle.cover_file_id)})` }}
      >
        {hasVideo && (
          <button
            className="inspector__play"
            onClick={() => onPlayBundle?.(bundleId)}
            aria-label="Play"
            title="Play"
          >
            ▶
          </button>
        )}
      </div>

      <ConflictNotice error={update.error} />

      <input
        className="edit edit--title"
        value={title}
        placeholder="Untitled"
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => commitTitle(title)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
        aria-label="Title"
      />

      <div className="prop">
        <span className="prop__k">Rating</span>
        <StarRating
          value={bundle.rating ?? 0}
          onChange={(v) => update.mutate({ rating: v === 0 ? null : v })}
        />
      </div>
      <div className="prop">
        <span className="prop__k">Files</span>
        <span className="prop__v">{files.length}</span>
      </div>
      <div className="prop">
        <span className="prop__k">Size</span>
        <span className="prop__v">
          {formatBytes(files.reduce((s, f) => s + (f.size_bytes ?? 0), 0))}
        </span>
      </div>
      <div className="prop">
        <span className="prop__k">Date Added</span>
        <span className="prop__v">{formatDate(bundle.created_at)}</span>
      </div>

      <div className="notes-head">
        <label className="field-label">Notes</label>
        <button
          className="notes-add"
          onClick={addNote}
          aria-label="Add note"
          title="Add another note"
        >
          +
        </button>
      </div>
      {notes.map((n, i) => (
        <div className="note-row" key={i}>
          <textarea
            className="edit edit--note"
            value={n}
            placeholder="Add a note…"
            onChange={(e) => changeNote(i, e.target.value)}
            onBlur={commitNotes}
            aria-label={notes.length > 1 ? `Note ${i + 1}` : 'Note'}
            rows={3}
          />
          {(notes.length > 1 || n.trim() !== '') && (
            <button
              className="note-remove"
              onClick={() => removeNote(i)}
              aria-label={`Remove note ${i + 1}`}
              title="Remove note"
            >
              ×
            </button>
          )}
        </div>
      ))}

      <TagEditor bundleId={bundleId} />
      <CollectionPicker bundleId={bundleId} />

      <FileList
        bundleId={bundleId}
        bundleVersion={bundle.version}
        coverId={bundle.cover_file_id ?? null}
        primaryId={bundle.primary_file_id ?? null}
        // Adding unbundled files targets a confirmed bundle only (ADR-0009).
        onAddFiles={bundle.grouping_state === 'confirmed' ? onAddFiles : undefined}
      />
    </aside>
  )
}

function FileList({
  bundleId,
  bundleVersion,
  coverId,
  primaryId,
  onAddFiles,
}: {
  bundleId: string
  bundleVersion: number
  coverId: string | null
  primaryId: string | null
  onAddFiles?: (bundleId: string) => void
}) {
  const { data: files = [] } = useBundleFiles(bundleId)
  const update = useUpdateBundle(bundleId, bundleVersion)
  const { reorder, remove } = useFileMutations(bundleId)

  const move = (index: number, delta: number) => {
    const target = index + delta
    const ids = files.map((f) => f.id)
    const a = ids[index]
    const b = ids[target]
    if (a === undefined || b === undefined) return
    ids[index] = b
    ids[target] = a
    reorder.mutate(ids)
  }

  return (
    <div className="files">
      <div className="sidebar__heading sidebar__heading--row" style={{ padding: '4px 0' }}>
        Files in bundle ({files.length})
        {onAddFiles && (
          <button
            className="sidebar__add"
            onClick={() => onAddFiles(bundleId)}
            title="Add unbundled files to this bundle"
            aria-label="Add files to this bundle"
          >
            +
          </button>
        )}
      </div>
      <ConflictNotice error={update.error} />
      {files.map((f, i) => {
        const meta = (f.tech_metadata ?? {}) as Record<string, unknown>
        const dims = formatDimensions(meta.width as number, meta.height as number)
        const dur = formatDuration(meta.duration as number)
        const thumbnailable = f.media_kind === 'image' || f.media_kind === 'video'
        return (
          <div className="file-row" key={f.id}>
            <div className="file-row__main">
              <div className="file-row__name">
                {f.id === primaryId && <span title="Primary">▶</span>}
                {f.id === coverId && <span title="Cover">★</span>} {f.display_title}
              </div>
              <div className="file-row__role">
                {f.role} · {dims !== '—' ? dims : dur !== '—' ? dur : formatBytes(f.size_bytes)}
              </div>
            </div>
            <div className="file-row__actions">
              <button
                className="tip"
                data-tip="Move up"
                aria-label="Move up"
                onClick={() => move(i, -1)}
                disabled={i === 0}
              >
                ↑
              </button>
              <button
                className="tip"
                data-tip="Move down"
                aria-label="Move down"
                onClick={() => move(i, 1)}
                disabled={i === files.length - 1}
              >
                ↓
              </button>
              <button
                className="tip"
                data-tip="Set as primary (played first)"
                aria-label="Set as primary file"
                onClick={() => update.mutate({ primary_file_id: f.id })}
              >
                ▶
              </button>
              {thumbnailable && (
                <button
                  className="tip"
                  data-tip="Set as cover"
                  aria-label="Set as cover"
                  onClick={() => update.mutate({ cover_file_id: f.id })}
                >
                  ★
                </button>
              )}
              <button
                className="tip"
                data-tip="Remove from bundle (keeps the file)"
                aria-label="Remove from bundle (keeps the file on disk)"
                onClick={() => remove.mutate(f.id)}
              >
                ×
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

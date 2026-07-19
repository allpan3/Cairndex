import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

import { ConflictError, type BundleRead, thumbnailUrl } from '../api/client'
import { useBundle, useBundleFiles, useFileMutations, useUpdateBundle } from '../api/hooks'
import { formatBytes, formatDate, formatDimensions, formatDuration } from '../lib/format'
import { usePersistentState } from '../state/usePersistentState'
import { CollectionPicker } from './CollectionPicker'
import { fileDragProps } from './dragOut'
import { IconPlus } from './icons'
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
  onStartFileDrag,
}: {
  bundleId: string | null
  /** Open the "Add files" manual bundling dialog for this bundle. */
  onAddFiles?: (bundleId: string) => void
  /** Open the unified media viewer for this bundle. */
  onPlayBundle?: (bundleId: string) => void
  /** Drag this bundle's files out to Finder/other apps (plan 3 §6). */
  onStartFileDrag?: (relativePaths: string[]) => void
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
      onStartFileDrag={onStartFileDrag}
    />
  )
}

function BundleEditor({
  bundle,
  onAddFiles,
  onPlayBundle,
  onStartFileDrag,
}: {
  bundle: BundleRead
  onAddFiles?: (bundleId: string) => void
  onPlayBundle?: (bundleId: string) => void
  onStartFileDrag?: (relativePaths: string[]) => void
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
  // Per-note box heights, persisted per bundle and aligned with the notes list
  // by index (add/remove keep the arrays in step; there is no reorder gesture).
  // A missing entry means auto-grow to fit content; a number is a fixed height
  // set by dragging that box's grip. Trailing auto entries are trimmed so the
  // stored arrays stay small.
  const [noteHeights, setNoteHeights] = usePersistentState<Record<string, (number | null)[]>>(
    'cairndex.noteHeights',
    {},
  )
  const heights = noteHeights[bundleId] ?? []
  const setNoteHeight = (index: number, height: number | null) => {
    setNoteHeights((prev) => {
      const arr = (prev[bundleId] ?? []).slice()
      while (arr.length <= index) arr.push(null)
      arr[index] = height
      while (arr.length > 0 && arr[arr.length - 1] == null) arr.pop()
      const next = { ...prev }
      if (arr.length > 0) next[bundleId] = arr
      else delete next[bundleId]
      return next
    })
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
    // Keep the per-note heights aligned with the notes list.
    setNoteHeights((prev) => {
      const arr = prev[bundleId]
      if (!arr) return prev
      const trimmed = arr.filter((_, j) => j !== i)
      while (trimmed.length > 0 && trimmed[trimmed.length - 1] == null) trimmed.pop()
      const nextMap = { ...prev }
      if (trimmed.length > 0) nextMap[bundleId] = trimmed
      else delete nextMap[bundleId]
      return nextMap
    })
  }

  // Dragging the cover drags the whole bundle out (= all its files). The shell
  // skips any missing member, so a partially-available bundle still drags the rest.
  // A file-less bundle is not a drag source (no ghost drag, no misleading tooltip).
  const coverDrag = fileDragProps(files.length > 0 ? onStartFileDrag : undefined, () =>
    files.map((f) => f.relative_path),
  )

  return (
    <aside className="inspector">
      <div
        className="inspector__cover"
        style={{ backgroundImage: `url(${thumbnailUrl(bundleId, bundle.updated_at)})` }}
        {...coverDrag}
        title={coverDrag.draggable ? 'Drag to copy this bundle’s files out' : undefined}
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
          <IconPlus />
        </button>
      </div>
      {notes.map((n, i) => (
        <NoteBox
          key={i}
          value={n}
          index={i}
          count={notes.length}
          height={heights[i] ?? null}
          onChange={(v) => changeNote(i, v)}
          onCommit={commitNotes}
          onRemove={() => removeNote(i)}
          onResize={(h) => setNoteHeight(i, h)}
        />
      ))}

      <TagEditor bundleId={bundleId} />
      <CollectionPicker bundleId={bundleId} />

      <FileList
        bundleId={bundleId}
        bundleVersion={bundle.version}
        coverId={bundle.cover_file_id ?? null}
        // Adding unbundled files targets a confirmed bundle only (ADR-0009).
        onAddFiles={bundle.grouping_state === 'confirmed' ? onAddFiles : undefined}
        onStartFileDrag={onStartFileDrag}
      />
    </aside>
  )
}

const MIN_NOTE_HEIGHT = 44

/** One note textarea. Auto-grows to fit its content until the owner drags the
 * resize grip; once a manual height is set (shared across all note boxes and
 * persisted) it becomes a fixed box with a scrollbar when the text overflows.
 * Double-clicking the grip returns to auto-fit. */
function NoteBox({
  value,
  index,
  count,
  height,
  onChange,
  onCommit,
  onRemove,
  onResize,
}: {
  value: string
  index: number
  count: number
  height: number | null
  onChange: (value: string) => void
  onCommit: () => void
  onRemove: () => void
  onResize: (height: number | null) => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)

  const grow = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto'
    // scrollHeight is the content+padding box; with border-box sizing add the
    // border so the last line isn't clipped by a couple of pixels.
    const border = el.offsetHeight - el.clientHeight
    el.style.height = `${el.scrollHeight + border}px`
  }

  // Apply the fixed height, or auto-grow to content, whenever either changes.
  // Layout effect so the size is right before paint (no first-frame flicker).
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    if (height != null) el.style.height = `${height}px`
    else grow(el)
  }, [value, height])

  // In auto mode, re-grow when the panel width changes and text rewraps. Only
  // width changes are acted on, so setting the height here can't feed back.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || height != null) return
    let lastWidth = el.clientWidth
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (width === undefined || Math.abs(width - lastWidth) < 0.5) return
      lastWidth = width
      grow(el)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [height])

  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = ref.current
    if (!el) return
    e.preventDefault()
    const startY = e.clientY
    const startHeight = el.offsetHeight
    // Only switch to a fixed height once the pointer has actually dragged, so a
    // stray click on the grip never locks the box out of auto-expand.
    let dragged = false
    const onMove = (ev: PointerEvent) => {
      if (!dragged && Math.abs(ev.clientY - startY) < 3) return
      dragged = true
      el.style.overflowY = 'auto' // reveal overflow while shrinking
      el.style.height = `${Math.max(MIN_NOTE_HEIGHT, Math.round(startHeight + ev.clientY - startY))}px`
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (dragged) {
        onResize(el.offsetHeight) // persist the chosen height (switches to fixed)
      } else if (height == null) {
        grow(el) // a click, not a drag: stay in auto-expand
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <div className="note-row">
      <textarea
        ref={ref}
        className="edit edit--note"
        style={{ resize: 'none', overflowY: height != null ? 'auto' : 'hidden' }}
        value={value}
        placeholder="Add a note…"
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
        aria-label={count > 1 ? `Note ${index + 1}` : 'Note'}
      />
      {(count > 1 || value.trim() !== '') && (
        <button
          className="note-remove"
          onClick={onRemove}
          aria-label={`Remove note ${index + 1}`}
          title="Remove note"
        >
          ×
        </button>
      )}
      <div
        className="note-resize"
        onPointerDown={startResize}
        onDoubleClick={() => onResize(null)}
        title="Drag to resize · double-click to fit"
        aria-hidden="true"
      />
    </div>
  )
}

function FileList({
  bundleId,
  bundleVersion,
  coverId,
  onAddFiles,
  onStartFileDrag,
}: {
  bundleId: string
  bundleVersion: number
  coverId: string | null
  onAddFiles?: (bundleId: string) => void
  onStartFileDrag?: (relativePaths: string[]) => void
}) {
  const { data: files = [] } = useBundleFiles(bundleId)
  const update = useUpdateBundle(bundleId, bundleVersion)
  const { reorder, remove } = useFileMutations(bundleId)
  const missingCount = files.filter((file) => file.availability !== 'available').length

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
        Files in bundle ({files.length}
        {missingCount > 0 ? ` · ${missingCount} missing` : ''})
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
          <div
            className={`file-row${f.availability !== 'available' ? ' file-row--missing' : ''}`}
            key={f.id}
          >
            <div
              className="file-row__main"
              {...fileDragProps(onStartFileDrag, () => [f.relative_path])}
              title={onStartFileDrag ? 'Drag to copy this file out' : undefined}
            >
              <div className="file-row__name">
                {f.id === coverId && <span title="Cover">★</span>}
                <span className="file-row__title">{f.display_title}</span>
                {f.availability !== 'available' && (
                  <span className="badge badge--missing">missing</span>
                )}
              </div>
              <div className="file-row__role">
                {f.role === 'primary_video' ? 'video' : f.role} ·{' '}
                {dims !== '—' ? dims : dur !== '—' ? dur : formatBytes(f.size_bytes)}
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

import { useState } from 'react'

import { ConflictError, type BundleRead, thumbnailUrl } from '../api/client'
import { useBundle, useBundleFiles, useFileMutations, useUpdateBundle } from '../api/hooks'
import { formatBytes, formatDate, formatDimensions, formatDuration } from '../lib/format'
import { CollectionPicker } from './CollectionPicker'
import { Player } from './Player'
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
}: {
  bundleId: string | null
  /** Open the "Add files" manual bundling dialog for this bundle. */
  onAddFiles?: (bundleId: string) => void
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
  return <BundleEditor key={bundle.id} bundle={bundle} onAddFiles={onAddFiles} />
}

function BundleEditor({
  bundle,
  onAddFiles,
}: {
  bundle: BundleRead
  onAddFiles?: (bundleId: string) => void
}) {
  const bundleId = bundle.id
  const { data: files = [] } = useBundleFiles(bundleId)
  const update = useUpdateBundle(bundleId, bundle.version)

  const [title, setTitle] = useState(bundle.title ?? '')
  const [note, setNote] = useState(bundle.note ?? '')
  const [playing, setPlaying] = useState(false)

  const hasVideo = files.some((f) => f.media_kind === 'video')

  const commit = (field: 'title' | 'note', value: string) => {
    if (value === (bundle[field] ?? '')) return
    update.mutate({ [field]: value === '' ? null : value })
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
            onClick={() => setPlaying(true)}
            aria-label="Play"
            title="Play"
          >
            ▶
          </button>
        )}
      </div>
      {playing && <Player bundleId={bundleId} onClose={() => setPlaying(false)} />}

      <ConflictNotice error={update.error} />

      <input
        className="edit edit--title"
        value={title}
        placeholder="Untitled"
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => commit('title', title)}
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

      <label className="field-label">Note</label>
      <textarea
        className="edit edit--note"
        value={note}
        placeholder="Add a note…"
        onChange={(e) => setNote(e.target.value)}
        onBlur={() => commit('note', note)}
        aria-label="Note"
        rows={3}
      />

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

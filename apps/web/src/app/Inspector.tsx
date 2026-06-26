import { useState } from 'react'

import { type BundleRead, thumbnailUrl } from '../api/client'
import { useBundle, useBundleFiles, useFileMutations, useUpdateBundle } from '../api/hooks'
import { formatBytes, formatDate, formatDimensions, formatDuration } from '../lib/format'
import { FolderPicker } from './FolderPicker'
import { Player } from './Player'
import { TagEditor } from './TagEditor'

function StarRating({ value, onChange }: { value: number; onChange: (v: number) => void }) {
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

export function Inspector({ bundleId }: { bundleId: string | null }) {
  const { data: bundle } = useBundle(bundleId)

  if (bundleId === null) {
    return (
      <aside className="inspector">
        <div className="state">Select a bundle to see its details.</div>
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
  return <BundleEditor key={bundle.id} bundle={bundle} />
}

function BundleEditor({ bundle }: { bundle: BundleRead }) {
  const bundleId = bundle.id
  const { data: files = [] } = useBundleFiles(bundleId)
  const update = useUpdateBundle(bundleId)

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
        style={{ backgroundImage: `url(${thumbnailUrl(bundleId)})` }}
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

      <input
        className="edit edit--title"
        value={title}
        placeholder="Untitled"
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => commit('title', title)}
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
      <FolderPicker bundleId={bundleId} />

      <FileList
        bundleId={bundleId}
        coverId={bundle.cover_file_id ?? null}
        primaryId={bundle.primary_file_id ?? null}
      />
    </aside>
  )
}

function FileList({
  bundleId,
  coverId,
  primaryId,
}: {
  bundleId: string
  coverId: string | null
  primaryId: string | null
}) {
  const { data: files = [] } = useBundleFiles(bundleId)
  const update = useUpdateBundle(bundleId)
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
      <div className="sidebar__heading" style={{ padding: '4px 0' }}>
        Files in bundle ({files.length})
      </div>
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
              <button title="Move up" onClick={() => move(i, -1)} disabled={i === 0}>
                ↑
              </button>
              <button
                title="Move down"
                onClick={() => move(i, 1)}
                disabled={i === files.length - 1}
              >
                ↓
              </button>
              <button
                title="Set as primary"
                onClick={() => update.mutate({ primary_file_id: f.id })}
              >
                ▶
              </button>
              {thumbnailable && (
                <button title="Set as cover" onClick={() => update.mutate({ cover_file_id: f.id })}>
                  ★
                </button>
              )}
              <button
                title="Remove from bundle (keeps the file on disk)"
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

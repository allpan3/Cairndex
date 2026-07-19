import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'

import type { FileSelection, FileSuggestion, TargetSuggestion } from '../api/client'
import {
  useBundle,
  useBundleDraft,
  useConfirmedBundleSearch,
  useManualBundling,
  useTargetSuggestions,
  useUnbundledFileSuggestions,
} from '../api/hooks'
import { withSkipNote } from './manualBundlingSkipNote'
import { usePinyinSearch } from './pinyin'

/**
 * Manual bundling assistant dialogs (Unbundled staging follow-up to ADR-0009).
 *
 * Each dialog turns *unbundled* files (scan-staged provisional bundles) into a
 * confirmed bundle. Suggestions are fetched automatically on open and shown with
 * a confidence/reason, but applying is always an explicit button press — nothing
 * is auto-applied, and no file on disk is ever moved, copied, renamed, or
 * deleted (all operations are metadata-only).
 */

// --- shared building blocks --------------------------------------------------
function Modal({
  title,
  onClose,
  children,
  footer,
  label,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
  footer: React.ReactNode
  label: string
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal modal--mb"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={label}
      >
        <div className="modal__head">
          <h2>{title}</h2>
          <button className="modal__close" onClick={onClose} aria-label="Cancel">
            ×
          </button>
        </div>
        <div className="mb-body">{children}</div>
        <div className="modal__actions">{footer}</div>
      </div>
    </div>,
    document.body,
  )
}

function Confidence({ value }: { value: number }) {
  const pct = Math.round(value * 100)
  const level = value >= 0.7 ? 'high' : value >= 0.4 ? 'med' : 'low'
  return (
    <span className={`mb-confidence mb-confidence--${level}`} title={`Confidence ${pct}%`}>
      {pct}%
    </span>
  )
}

/** A file basename for compact display, with the parent folder as a subtitle. */
function pathParts(relativePath: string): { name: string; dir: string } {
  const slash = relativePath.lastIndexOf('/')
  return {
    name: slash >= 0 ? relativePath.slice(slash + 1) : relativePath,
    dir: slash >= 0 ? relativePath.slice(0, slash) : '',
  }
}

function FileCheckRow({
  suggestion,
  checked,
  onToggle,
}: {
  suggestion: FileSuggestion
  checked: boolean
  onToggle: () => void
}) {
  const { name, dir } = pathParts(suggestion.relative_path)
  return (
    <label className="mb-row">
      <input type="checkbox" checked={checked} onChange={onToggle} />
      <span className="mb-row__main">
        <span className="mb-row__name">{name}</span>
        {dir && <span className="mb-row__dir">{dir}</span>}
        <span className="mb-row__reason">{suggestion.reason}</span>
      </span>
      <Confidence value={suggestion.confidence} />
    </label>
  )
}

function EmptyOrError({
  isLoading,
  isError,
  isEmpty,
  emptyText,
}: {
  isLoading: boolean
  isError: boolean
  isEmpty: boolean
  emptyText: string
}) {
  if (isLoading) return <div className="mb-state">Finding suggestions…</div>
  if (isError) return <div className="mb-state mb-state--error">Couldn’t load suggestions.</div>
  if (isEmpty) return <div className="mb-state">{emptyText}</div>
  return null
}

function SelectedFilesNote({ count }: { count: number }) {
  return (
    <div className="mb-selected">
      {count} file{count === 1 ? '' : 's'} selected
    </div>
  )
}

const selCount = (s: FileSelection) => (s.fileIds?.length ?? 0) + (s.relativePaths?.length ?? 0)

// --- Add to existing bundle --------------------------------------------------
export function AddToBundleDialog({
  selection,
  onClose,
  onApplied,
}: {
  selection: FileSelection
  onClose: () => void
  onApplied: (message: string) => void
}) {
  const suggestions = useTargetSuggestions(selection)
  const [targetId, setTargetId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const search = useConfirmedBundleSearch(query)
  const { addFiles } = useManualBundling()

  // Merge auto-suggestions with manual-search hits into one selectable list,
  // suggestions first, de-duplicated by bundle id.
  const options = useMemo(() => {
    const merged: { id: string; title: string | null; reason?: string; confidence?: number }[] = []
    const seen = new Set<string>()
    for (const s of suggestions.data ?? []) {
      if (seen.has(s.bundle_id)) continue
      seen.add(s.bundle_id)
      merged.push({ id: s.bundle_id, title: s.title, reason: s.reason, confidence: s.confidence })
    }
    if (query.trim()) {
      for (const b of search.data?.items ?? []) {
        if (seen.has(b.id)) continue
        seen.add(b.id)
        merged.push({ id: b.id, title: b.title })
      }
    }
    return merged
  }, [suggestions.data, search.data, query])

  const apply = () => {
    if (!targetId) return
    addFiles.mutate(
      { bundleId: targetId, sel: selection },
      {
        onSuccess: (r) =>
          onApplied(
            withSkipNote(
              `Added ${r.files_added} file${r.files_added === 1 ? '' : 's'} to the bundle.`,
              r,
            ),
          ),
      },
    )
  }

  return (
    <Modal
      title="Add to Bundle"
      label="Add to bundle"
      onClose={onClose}
      footer={
        <>
          <SelectedFilesNote count={selCount(selection)} />
          <span className="toolbar__spacer" />
          <button className="btn" onClick={onClose} disabled={addFiles.isPending}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            onClick={apply}
            disabled={!targetId || addFiles.isPending}
          >
            {addFiles.isPending ? 'Adding…' : 'Add to bundle'}
          </button>
        </>
      }
    >
      <label className="mb-label">Suggested bundles</label>
      <EmptyOrError
        isLoading={suggestions.isLoading}
        isError={suggestions.isError}
        isEmpty={(suggestions.data?.length ?? 0) === 0 && !query.trim()}
        emptyText="No likely bundles found — search for one below."
      />
      <div className="mb-list" role="radiogroup" aria-label="Target bundle">
        {options.map((o) => (
          <label className="mb-row" key={o.id}>
            <input
              type="radio"
              name="mb-target"
              checked={targetId === o.id}
              onChange={() => setTargetId(o.id)}
            />
            <span className="mb-row__main">
              <span className="mb-row__name">{o.title ?? 'Untitled bundle'}</span>
              {o.reason && <span className="mb-row__reason">{o.reason}</span>}
            </span>
            {o.confidence !== undefined && <Confidence value={o.confidence} />}
          </label>
        ))}
      </div>

      <label className="mb-label" htmlFor="mb-target-search">
        Search for a bundle
      </label>
      <input
        id="mb-target-search"
        className="edit"
        placeholder="Search confirmed bundles by name…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {addFiles.isError && (
        <div className="mb-state mb-state--error">
          {addFiles.error instanceof Error ? addFiles.error.message : 'Failed to add files.'}
        </div>
      )}
    </Modal>
  )
}

// --- Create bundle from selected unbundled files -----------------------------
export function CreateBundleDialog({
  selection,
  onClose,
  onApplied,
}: {
  selection: FileSelection
  onClose: () => void
  onApplied: (message: string) => void
}) {
  const draft = useBundleDraft(selection)
  // `null` until the user types: the field then shows the suggested title as it
  // arrives, without a setState-in-effect (derived, not synced).
  const [typedTitle, setTypedTitle] = useState<string | null>(null)
  const [extra, setExtra] = useState<Set<string>>(new Set())
  const { createFromFiles } = useManualBundling()

  const title = typedTitle ?? draft.data?.proposed_title ?? ''

  const toggle = (id: string) =>
    setExtra((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const apply = () => {
    // The seed selection (ids and/or paths) plus any checked additional files
    // (suggested unbundled files, always backend ids).
    const sel: FileSelection = {
      fileIds: [...(selection.fileIds ?? []), ...extra],
      relativePaths: selection.relativePaths,
    }
    createFromFiles.mutate(
      { sel, title: title.trim() || null },
      {
        onSuccess: (r) =>
          onApplied(
            withSkipNote(
              `Created a bundle from ${r.files_added} file${r.files_added === 1 ? '' : 's'}.`,
              r,
            ),
          ),
      },
    )
  }

  const additional = draft.data?.additional ?? []
  const seedCount = selCount(selection)
  // The preview mirrors apply's filtering, so an empty `roles` (with a non-empty
  // selection and no extra picked) means every selected file is non-media: there
  // is nothing to bundle, so explain instead of offering a dead-end submit (P1-5).
  const nothingToBundle =
    draft.isSuccess && seedCount > 0 && (draft.data?.roles.length ?? 0) === 0 && extra.size === 0

  return (
    <Modal
      title="Create Bundle"
      label="Create bundle"
      onClose={onClose}
      footer={
        <>
          <SelectedFilesNote count={seedCount + extra.size} />
          <span className="toolbar__spacer" />
          <button className="btn" onClick={onClose} disabled={createFromFiles.isPending}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            onClick={apply}
            disabled={seedCount === 0 || nothingToBundle || createFromFiles.isPending}
          >
            {createFromFiles.isPending ? 'Creating…' : 'Create bundle'}
          </button>
        </>
      }
    >
      {nothingToBundle && (
        <div className="mb-state mb-state--error">
          None of the selected files are linkable media, so there’s nothing to bundle. Drop media
          files (not folders or sidecars) that already live in this library.
        </div>
      )}
      <label className="mb-label" htmlFor="mb-create-title">
        Title
      </label>
      <input
        id="mb-create-title"
        className="edit"
        placeholder="Bundle title"
        value={title}
        onChange={(e) => setTypedTitle(e.target.value)}
      />

      <label className="mb-label">
        Also include these nearby files?{' '}
        {additional.length > 0 && <span className="mb-hint">({additional.length} suggested)</span>}
      </label>
      <EmptyOrError
        isLoading={draft.isLoading}
        isError={draft.isError}
        isEmpty={additional.length === 0}
        emptyText="No related unbundled files found nearby."
      />
      <div className="mb-list">
        {additional.map((s) => (
          <FileCheckRow
            key={s.file_id}
            suggestion={s}
            checked={extra.has(s.file_id)}
            onToggle={() => toggle(s.file_id)}
          />
        ))}
      </div>

      {createFromFiles.isError && (
        <div className="mb-state mb-state--error">
          {createFromFiles.error instanceof Error
            ? createFromFiles.error.message
            : 'Failed to create bundle.'}
        </div>
      )}
    </Modal>
  )
}

// --- Add unbundled files into an existing bundle (from bundle detail, or after
// creating an empty bundle) ---------------------------------------------------
export function AddFilesToBundleDialog({
  bundleId,
  onClose,
  onApplied,
}: {
  bundleId: string
  onClose: () => void
  onApplied: (message: string) => void
}) {
  const bundle = useBundle(bundleId)
  const suggestions = useUnbundledFileSuggestions(bundleId)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const matchSearch = usePinyinSearch(filter)
  const { addFiles } = useManualBundling()

  const toggle = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const visible = useMemo(() => {
    const list = suggestions.data ?? []
    const q = filter.trim()
    return q ? list.filter((s) => matchSearch(s.relative_path)) : list
  }, [suggestions.data, filter, matchSearch])

  const apply = () => {
    addFiles.mutate(
      { bundleId, sel: { fileIds: [...checked] } },
      {
        onSuccess: (r) =>
          onApplied(
            withSkipNote(
              `Added ${r.files_added} file${r.files_added === 1 ? '' : 's'} to the bundle.`,
              r,
            ),
          ),
      },
    )
  }

  return (
    <Modal
      title={`Add Files${bundle.data?.title ? ` to “${bundle.data.title}”` : ''}`}
      label="Add files to bundle"
      onClose={onClose}
      footer={
        <>
          <SelectedFilesNote count={checked.size} />
          <span className="toolbar__spacer" />
          <button className="btn" onClick={onClose} disabled={addFiles.isPending}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            onClick={apply}
            disabled={checked.size === 0 || addFiles.isPending}
          >
            {addFiles.isPending ? 'Adding…' : 'Add files'}
          </button>
        </>
      }
    >
      <label className="mb-label">Suggested unbundled files</label>
      <input
        className="edit"
        placeholder="Filter suggestions…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <EmptyOrError
        isLoading={suggestions.isLoading}
        isError={suggestions.isError}
        isEmpty={visible.length === 0}
        emptyText={
          filter.trim() ? 'No suggestions match your filter.' : 'No matching unbundled files found.'
        }
      />
      <div className="mb-list">
        {visible.map((s) => (
          <FileCheckRow
            key={s.file_id}
            suggestion={s}
            checked={checked.has(s.file_id)}
            onToggle={() => toggle(s.file_id)}
          />
        ))}
      </div>

      {addFiles.isError && (
        <div className="mb-state mb-state--error">
          {addFiles.error instanceof Error ? addFiles.error.message : 'Failed to add files.'}
        </div>
      )}
    </Modal>
  )
}

// --- Create an empty confirmed bundle (toolbar / empty-space action) ---------
// After creation the parent opens AddFilesToBundleDialog so the owner can pull
// in suggested unbundled files (or leave the bundle empty).
export function CreateEmptyBundleDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (bundleId: string) => void
}) {
  const [title, setTitle] = useState('')
  const { createEmpty } = useManualBundling()

  const create = () => {
    createEmpty.mutate(title.trim() || null, {
      onSuccess: (r) => onCreated(r.bundle_id),
    })
  }

  return (
    <Modal
      title="Create Bundle"
      label="Create empty bundle"
      onClose={onClose}
      footer={
        <>
          <span className="toolbar__spacer" />
          <button className="btn" onClick={onClose} disabled={createEmpty.isPending}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={create} disabled={createEmpty.isPending}>
            {createEmpty.isPending ? 'Creating…' : 'Create'}
          </button>
        </>
      }
    >
      <label className="mb-label" htmlFor="mb-empty-title">
        Title
      </label>
      <input
        id="mb-empty-title"
        className="edit"
        placeholder="Bundle title"
        value={title}
        autoFocus
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !createEmpty.isPending) create()
        }}
      />
      <div className="mb-state">
        You’ll be able to add suggested unbundled files after the bundle is created.
      </div>
      {createEmpty.isError && (
        <div className="mb-state mb-state--error">
          {createEmpty.error instanceof Error
            ? createEmpty.error.message
            : 'Failed to create bundle.'}
        </div>
      )}
    </Modal>
  )
}

export type { TargetSuggestion }

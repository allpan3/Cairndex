import { useEffect, useRef, useState } from 'react'

import { type StorageRootRead, fetchPathSuggestions } from '../api/client'
import { useLibraryMutations, useStorageRoots } from '../api/hooks'

/**
 * Add and manage libraries (storage roots). A library is an owner-configured
 * server directory the app links files from. Adding one takes an absolute server
 * path (with directory autocomplete) and can create the folder if it's missing;
 * the path is owner-trusted setup, distinct from per-request path safety.
 */
export function LibraryManager({ onClose }: { onClose: () => void }) {
  const roots = useStorageRoots()
  const { create, remove } = useLibraryMutations()

  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [createIfMissing, setCreateIfMissing] = useState(false)

  const submit = () => {
    if (!name.trim() || !path.trim()) return
    create.mutate(
      {
        name: name.trim(),
        canonical_path: path.trim(),
        create_if_missing: createIfMissing,
        read_only: true,
      },
      {
        onSuccess: () => {
          setName('')
          setPath('')
          setCreateIfMissing(false)
        },
      },
    )
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="modal__head">
          <h2>Libraries</h2>
          <button className="modal__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="lib-list">
          {(roots.data ?? []).length === 0 && (
            <div className="inspector__empty">No libraries yet. Add one below.</div>
          )}
          {(roots.data ?? []).map((r) => (
            <LibraryRow key={r.id} root={r} onRemove={() => remove.mutate(r.id)} />
          ))}
        </div>

        <div className="lib-add">
          <label className="field-label">Name</label>
          <input
            className="edit"
            value={name}
            placeholder="e.g. NAS Movies"
            onChange={(e) => setName(e.target.value)}
            aria-label="Library name"
          />

          <label className="field-label">Path</label>
          <PathInput value={path} onChange={setPath} />

          <label className="lib-add__check">
            <input
              type="checkbox"
              checked={createIfMissing}
              onChange={(e) => setCreateIfMissing(e.target.checked)}
            />
            Create the folder if it doesn&apos;t exist
          </label>

          {(create.error || remove.error) && (
            <div className="modal__error">{((create.error ?? remove.error) as Error).message}</div>
          )}

          <div className="modal__actions">
            <span className="toolbar__spacer" />
            <button
              className="btn btn--primary"
              onClick={submit}
              disabled={create.isPending || !name.trim() || !path.trim()}
            >
              Add library
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function LibraryRow({ root, onRemove }: { root: StorageRootRead; onRemove: () => void }) {
  const available = root.status === 'available'
  return (
    <div className="lib-row">
      <div className="lib-row__main">
        <span className="lib-row__name">{root.name}</span>
        <span className="lib-row__path">{root.canonical_path}</span>
      </div>
      <span className={`badge ${available ? 'badge--ok' : 'badge--warn'}`}>
        {available ? 'available' : 'unavailable'}
      </span>
      <button
        className="btn btn--danger btn--sm"
        onClick={onRemove}
        aria-label={`Remove ${root.name}`}
      >
        Remove
      </button>
    </div>
  )
}

/** Absolute-path input with Jellyfin-style directory autocomplete. */
function PathInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  // Debounced suggestion fetch as the path is typed.
  useEffect(() => {
    const handle = setTimeout(() => {
      fetchPathSuggestions(value)
        .then(setSuggestions)
        .catch(() => setSuggestions([]))
    }, 180)
    return () => clearTimeout(handle)
  }, [value])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  return (
    <div className="path-input" ref={boxRef}>
      <input
        className="edit"
        value={value}
        placeholder="/absolute/path/on/the/server"
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        aria-label="Library path"
        autoComplete="off"
        spellCheck={false}
      />
      {open && suggestions.length > 0 && (
        <div className="path-input__menu" role="listbox">
          {suggestions.map((s) => (
            <button
              key={s}
              className="path-input__opt"
              role="option"
              aria-selected={false}
              onClick={() => {
                onChange(s)
                setOpen(false) // re-focus or type "/" to drill nested
              }}
            >
              🗀 {s}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'

import { type LibraryRead, fetchPathSuggestions } from '../api/client'
import { useLibraries, useLibraryMutations } from '../api/hooks'

/**
 * Add and manage libraries (ADR-0008). A library is a directory carrying its own
 * `.cairndex/` metadata. You can **create** a new library at an absolute server
 * path (with directory autocomplete; optionally creating the folder), or
 * **register** an existing library directory. The path is owner-trusted setup,
 * distinct from per-request path safety.
 */
export function LibraryManager({ onClose }: { onClose: () => void }) {
  const libraries = useLibraries()
  const { create, register } = useLibraryMutations()

  const [mode, setMode] = useState<'create' | 'register'>('create')
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [createIfMissing, setCreateIfMissing] = useState(false)

  const reset = () => {
    setName('')
    setPath('')
    setCreateIfMissing(false)
  }

  const submit = () => {
    if (!path.trim()) return
    if (mode === 'register') {
      register.mutate({ root_path: path.trim() }, { onSuccess: reset })
      return
    }
    if (!name.trim()) return
    create.mutate(
      { root_path: path.trim(), display_name: name.trim(), create_if_missing: createIfMissing },
      { onSuccess: reset },
    )
  }

  const error = (create.error ?? register.error) as Error | null
  const busy = create.isPending || register.isPending

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
          {(libraries.data ?? []).length === 0 && (
            <div className="inspector__empty">No libraries yet. Add one below.</div>
          )}
          {(libraries.data ?? []).map((lib) => (
            <LibraryRow key={lib.id} library={lib} />
          ))}
        </div>

        <div className="lib-add">
          <div className="sidebar__modes" role="tablist" aria-label="Add mode">
            <button
              role="tab"
              aria-selected={mode === 'create'}
              className={`mode-tab${mode === 'create' ? ' mode-tab--active' : ''}`}
              onClick={() => setMode('create')}
            >
              Create new
            </button>
            <button
              role="tab"
              aria-selected={mode === 'register'}
              className={`mode-tab${mode === 'register' ? ' mode-tab--active' : ''}`}
              onClick={() => setMode('register')}
            >
              Register existing
            </button>
          </div>

          {mode === 'create' && (
            <>
              <label className="field-label">Name</label>
              <input
                className="edit"
                value={name}
                placeholder="e.g. NAS Movies"
                onChange={(e) => setName(e.target.value)}
                aria-label="Library name"
              />
            </>
          )}

          <label className="field-label">Path</label>
          <PathInput value={path} onChange={setPath} />

          {mode === 'create' && (
            <label className="lib-add__check">
              <input
                type="checkbox"
                checked={createIfMissing}
                onChange={(e) => setCreateIfMissing(e.target.checked)}
              />
              Create the folder if it doesn&apos;t exist
            </label>
          )}

          {error && <div className="modal__error">{error.message}</div>}

          <div className="modal__actions">
            <span className="toolbar__spacer" />
            <button
              className="btn btn--primary"
              onClick={submit}
              disabled={busy || !path.trim() || (mode === 'create' && !name.trim())}
            >
              {mode === 'create' ? 'Create library' : 'Register library'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function LibraryRow({ library }: { library: LibraryRead }) {
  const available = library.status === 'available'
  return (
    <div className="lib-row">
      <div className="lib-row__main">
        <span className="lib-row__name">{library.name}</span>
        <span className="lib-row__path">{library.root_path}</span>
      </div>
      <span className={`badge ${available ? 'badge--ok' : 'badge--warn'}`}>
        {available ? 'available' : 'unavailable'}
      </span>
    </div>
  )
}

/** Absolute-path input with Jellyfin-style directory autocomplete. */
function PathInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

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
                setOpen(false)
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

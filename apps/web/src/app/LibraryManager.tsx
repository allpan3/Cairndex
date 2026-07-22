import { useEffect, useRef, useState } from 'react'

import { type LibraryRead, type PathSuggestion, fetchPathSuggestions } from '../api/client'
import { useLibraries, useLibraryMutations } from '../api/hooks'
import { confirmPickedLibrary, openLibraryFolder } from '../desktop/openLibraryFolder'
import { hostOperationErrorMessage, isDesktopHost } from '../platform'

/**
 * Add and manage libraries (ADR-0008). A library is a directory carrying its own
 * `.cairndex/` metadata.
 *
 * There is one **Add library** action, not a create/register choice: the owner
 * says *where*, and the server says what that is. An already-registered folder
 * is selected, an existing library is registered under the name it travels
 * with, and anything else is offered as a new library named after its folder.
 * Which of the three it is was never something the owner should have had to
 * know before typing a path.
 *
 * The path is owner-trusted setup, distinct from per-request path safety. On
 * desktop, **Browse…** reaches the same three outcomes through the native
 * picker; the browser has only the typed path, because no browser can produce
 * an absolute path on the server.
 */
export function LibraryManager({
  onClose,
  onSelect,
  onRemoved,
}: {
  onClose: () => void
  /** Make one library active — after adding it, or after selecting an existing one. */
  onSelect?: (libraryId: string) => void
  /** A library left the registry, so its cached content must not outlive it. */
  onRemoved?: (libraryId: string) => void
}) {
  const libraries = useLibraries()
  const { create, register, probe, remove } = useLibraryMutations()

  const [path, setPath] = useState('')
  const [confirming, setConfirming] = useState<ConfirmState | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Set while a shell command (the native picker, the confirm) is in flight;
  // those are not mutations, so they have no `isPending` of their own.
  const [hostBusy, setHostBusy] = useState(false)

  const rows = libraries.data ?? []
  const busy =
    hostBusy || create.isPending || register.isPending || probe.isPending || remove.isPending

  // Resolve one typed path into the single action it implies.
  const submitPath = async () => {
    const trimmed = path.trim()
    if (!trimmed || busy) return
    setError(null)
    try {
      const found = await probe.mutateAsync(trimmed)
      if (found.already_registered_id) {
        // Already here. Selecting it is the whole action — registering again
        // would only conflict.
        onSelect?.(found.already_registered_id)
        onClose()
        return
      }
      if (found.is_library) {
        const added = await register.mutateAsync({ root_path: trimmed })
        onSelect?.(added.id)
        onClose()
        return
      }
      setConfirming({
        kind: 'path',
        path: trimmed,
        createFolder: !found.exists,
        // The basename is empty only for a filesystem root; fall back to the
        // typed path so the name field is never blank.
        folderName: found.folder_name || trimmed,
      })
    } catch (failure) {
      setError(messageOf(failure))
    }
  }

  // Desktop only: the same three outcomes, reached through the native picker.
  const browse = async () => {
    if (busy) return
    setError(null)
    setHostBusy(true)
    try {
      const { opened } = await openLibraryFolder(
        rows.map((library) => library.library_uuid).filter(Boolean),
      )
      if (!opened) return // cancelled — nothing changed
      if (opened.needsConfirmation && opened.token) {
        setConfirming({
          kind: 'pick',
          token: opened.token,
          folderName: opened.folderName ?? '',
        })
        return
      }
      if (opened.alreadyAvailable) {
        const here = rows.find((library) => library.library_uuid === opened.libraryUuid)
        if (here) onSelect?.(here.id)
      }
      // Anything else already switched to the local connection and queued its
      // own selection, which lands after the remount this modal will not survive.
      onClose()
    } catch (failure) {
      setError(hostOperationErrorMessage(failure))
    } finally {
      setHostBusy(false)
    }
  }

  const confirmNewLibrary = async (name: string) => {
    if (!confirming || busy) return
    setError(null)
    try {
      if (confirming.kind === 'pick') {
        setHostBusy(true)
        try {
          // The shell holds the folder against this token; it never crossed
          // into this layer, and a token a later pick superseded is refused.
          await confirmPickedLibrary(confirming.token, name)
        } finally {
          setHostBusy(false)
        }
      } else {
        const added = await create.mutateAsync({
          root_path: confirming.path,
          display_name: name,
          create_if_missing: confirming.createFolder,
        })
        onSelect?.(added.id)
      }
      onClose()
    } catch (failure) {
      setError(confirming.kind === 'pick' ? hostOperationErrorMessage(failure) : messageOf(failure))
    }
  }

  const removeLibrary = (libraryId: string) => {
    setError(null)
    remove.mutate(libraryId, {
      onSuccess: () => onRemoved?.(libraryId),
      onError: (failure) => setError(messageOf(failure)),
    })
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
          {rows.length === 0 && (
            <div className="inspector__empty">No libraries yet. Add one below.</div>
          )}
          {rows.map((library) => (
            <LibraryRow
              key={library.id}
              library={library}
              busy={busy}
              onRemove={() => removeLibrary(library.id)}
            />
          ))}
        </div>

        {confirming ? (
          <div className="lib-add">
            <NewLibraryConfirm
              key={`${confirming.kind}:${confirming.folderName}`}
              folderName={confirming.folderName}
              willCreateFolder={confirming.kind === 'path' && confirming.createFolder}
              busy={busy}
              onConfirm={(name) => void confirmNewLibrary(name)}
              onCancel={() => {
                setConfirming(null)
                setError(null)
              }}
            />
            {error && <div className="modal__error">{error}</div>}
          </div>
        ) : (
          <div className="lib-add">
            <label className="field-label" htmlFor="library-path">
              Add library
            </label>
            {/* One row, so the suggestion menu — which stays open to drill down —
                drops over the hint text below rather than over the action it
                would otherwise swallow the click for. */}
            <div className="lib-add__row">
              <PathInput value={path} onChange={setPath} onSubmit={() => void submitPath()} />
              {isDesktopHost() && (
                <button className="btn" onClick={() => void browse()} disabled={busy}>
                  Browse…
                </button>
              )}
              <button
                className="btn btn--primary"
                onClick={() => void submitPath()}
                disabled={busy || !path.trim()}
              >
                Add library
              </button>
            </div>
            <p className="lib-add__hint">
              An absolute path on the server. An existing library is added as it is; any other
              folder is offered as a new one.
            </p>

            {error && <div className="modal__error">{error}</div>}
          </div>
        )}
      </div>
    </div>
  )
}

/** A folder awaiting a name, from either entry path. */
type ConfirmState =
  | { kind: 'path'; path: string; createFolder: boolean; folderName: string }
  // `token` stands in for the folder the shell picked and is holding; the path
  // itself never enters this layer (see `mappings::PickedFolder`).
  | { kind: 'pick'; token: string; folderName: string }

/**
 * The "this isn't a library yet" step, shared by both entry paths.
 *
 * Prefilled with the folder's own name, so confirming is one keystroke and
 * renaming is still right there. Rendered inside the manager's modal, and by
 * {@link NewLibraryDialog} on its own for the File menu's picker.
 */
export function NewLibraryConfirm({
  folderName,
  willCreateFolder = false,
  busy,
  onConfirm,
  onCancel,
}: {
  folderName: string
  /** The typed path does not exist yet, so confirming creates the folder too. */
  willCreateFolder?: boolean
  busy: boolean
  onConfirm: (name: string) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(folderName)
  const trimmed = name.trim()

  return (
    <form
      className="lib-confirm"
      onSubmit={(event) => {
        event.preventDefault()
        if (trimmed && !busy) onConfirm(trimmed)
      }}
    >
      <p className="lib-confirm__ask">
        {willCreateFolder
          ? 'This folder doesn’t exist yet. Create it as a new Cairndex library?'
          : 'This folder isn’t a Cairndex library. Register it as a new library?'}
      </p>
      <label className="field-label" htmlFor="new-library-name">
        Name
      </label>
      <input
        id="new-library-name"
        className="edit"
        value={name}
        onChange={(event) => setName(event.target.value)}
        aria-label="Library name"
        autoFocus
        spellCheck={false}
      />
      <div className="modal__actions">
        <span className="toolbar__spacer" />
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button className="btn btn--primary" disabled={busy || !trimmed}>
          {willCreateFolder ? 'Create library' : 'Add library'}
        </button>
      </div>
    </form>
  )
}

/**
 * {@link NewLibraryConfirm} as a modal of its own.
 *
 * The File → Open Library Folder… path can land on a plain folder from anywhere
 * — including the first-run screen, where no manager is open — so the same
 * question has to be askable without one.
 */
export function NewLibraryDialog({
  folderName,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  folderName: string
  busy: boolean
  error: string | null
  onConfirm: (name: string) => void
  onCancel: () => void
}) {
  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div
        className="modal"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="modal__head">
          <h2>Add library</h2>
          <button className="modal__close" onClick={onCancel} aria-label="Close">
            ×
          </button>
        </div>
        <NewLibraryConfirm
          key={folderName}
          folderName={folderName}
          busy={busy}
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
        {error && <div className="modal__error">{error}</div>}
      </div>
    </div>
  )
}

function LibraryRow({
  library,
  busy,
  onRemove,
}: {
  library: LibraryRead
  busy: boolean
  onRemove: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const available = library.status === 'available'

  if (confirming) {
    return (
      <div className="lib-row lib-row--confirm">
        <div className="lib-row__main">
          <span className="lib-row__name">Remove “{library.name}” from this server?</span>
          {/* The one thing worth stating plainly: removal is a list operation.
              Its own class, because the path line truncates and this sentence
              is exactly the one that must not be cut off. */}
          <span className="lib-row__note">
            The folder and its files are not touched. You can add it back later.
          </span>
        </div>
        <button className="btn btn--sm" onClick={() => setConfirming(false)} disabled={busy}>
          Cancel
        </button>
        <button className="btn btn--sm btn--danger" onClick={onRemove} disabled={busy}>
          Remove
        </button>
      </div>
    )
  }

  return (
    <div className="lib-row">
      <div className="lib-row__main">
        <span className="lib-row__name">{library.name}</span>
        <span className="lib-row__path">{library.root_path}</span>
      </div>
      <span className={`badge ${available ? 'badge--ok' : 'badge--warn'}`}>
        {available ? 'available' : 'unavailable'}
      </span>
      <button
        className="btn btn--sm"
        onClick={() => setConfirming(true)}
        disabled={busy}
        aria-label={`Remove ${library.name}`}
      >
        Remove
      </button>
    </div>
  )
}

// The longest prefix every suggestion shares, for Tab completion. Empty when the
// suggestions diverge immediately, in which case there is nothing to complete.
function longestCommonPrefix(values: string[]): string {
  if (values.length === 0) return ''
  let prefix = values[0] as string
  for (const value of values.slice(1)) {
    let i = 0
    while (i < prefix.length && i < value.length && prefix[i] === value[i]) i += 1
    prefix = prefix.slice(0, i)
    if (!prefix) break
  }
  return prefix
}

/**
 * Absolute-path input with Jellyfin-style directory autocomplete.
 *
 * Fully keyboard-drivable, because typing a path is a keyboard task and the
 * mouse-only menu made the fastest input method the slowest: Down/Up move
 * through the suggestions, Enter takes the active one (or submits when none is
 * active), Tab completes as far as the suggestions agree, Escape closes the
 * menu. Taking a suggestion appends a separator and keeps the menu open, so one
 * key per level walks down a tree.
 */
function PathInput({
  value,
  onChange,
  onSubmit,
}: {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
}) {
  const [suggestions, setSuggestions] = useState<PathSuggestion[]>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const boxRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handle = setTimeout(() => {
      fetchPathSuggestions(value)
        .then((next) => {
          setSuggestions(next)
          // The list the active index pointed into is gone; pointing at an entry
          // by position would make Enter accept whatever moved into that slot.
          setActive(-1)
        })
        .catch(() => {
          setSuggestions([])
          setActive(-1)
        })
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

  // Keeps the keyboard-active option visible in the scrolling menu.
  useEffect(() => {
    if (active < 0) return
    menuRef.current?.children[active]?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const accept = (suggestion: PathSuggestion) => {
    // Trailing separator: the next suggestion request then lists this
    // directory's children rather than its siblings, so the menu stays open and
    // drills down instead of ending the interaction.
    onChange(`${suggestion.path}/`)
    setActive(-1)
    setOpen(true)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (suggestions.length === 0) return
      event.preventDefault()
      if (!open) {
        setOpen(true)
        return
      }
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((current) => {
        const next = current + step
        if (next < 0) return suggestions.length - 1
        if (next >= suggestions.length) return 0
        return next
      })
      return
    }
    if (event.key === 'Enter') {
      const chosen = open ? suggestions[active] : undefined
      if (chosen) {
        event.preventDefault()
        accept(chosen)
        return
      }
      // No active option: Enter is the form's, not the menu's.
      event.preventDefault()
      setOpen(false)
      onSubmit()
      return
    }
    if (event.key === 'Escape') {
      if (!open) return
      event.preventDefault()
      setOpen(false)
      setActive(-1)
      return
    }
    if (event.key === 'Tab' && !event.shiftKey) {
      const chosen = open ? suggestions[active] : undefined
      if (chosen) {
        event.preventDefault()
        accept(chosen)
        return
      }
      const shared = longestCommonPrefix(suggestions.map((item) => item.path))
      // Only when it actually adds something — otherwise Tab must keep moving
      // focus, which is the one behavior a keyboard user cannot lose.
      if (shared.length > value.length && shared.startsWith(value)) {
        event.preventDefault()
        onChange(shared)
        setOpen(true)
      }
    }
  }

  const activeId = active >= 0 && suggestions[active] ? `path-option-${active}` : undefined

  return (
    <div className="path-input" ref={boxRef}>
      <input
        id="library-path"
        className="edit"
        value={value}
        placeholder="/absolute/path/on/the/server"
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        aria-label="Library path"
        role="combobox"
        aria-expanded={open && suggestions.length > 0}
        aria-controls="path-suggestions"
        aria-activedescendant={activeId}
        aria-autocomplete="list"
        autoComplete="off"
        spellCheck={false}
      />
      {open && suggestions.length > 0 && (
        <div className="path-input__menu" role="listbox" id="path-suggestions" ref={menuRef}>
          {suggestions.map((suggestion, index) => (
            <button
              key={suggestion.path}
              id={`path-option-${index}`}
              type="button"
              className={`path-input__opt${index === active ? ' path-input__opt--active' : ''}`}
              role="option"
              aria-selected={index === active}
              // Mouse down inside the menu must not blur the input first.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => accept(suggestion)}
            >
              🗀 {suggestion.path}
              {suggestion.is_library && <span className="path-input__badge">library</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// Renders whatever a failed request or command carried, without leaking objects
function messageOf(failure: unknown): string {
  if (failure instanceof Error) return failure.message
  if (typeof failure === 'string') return failure
  return 'Something went wrong. Try again.'
}

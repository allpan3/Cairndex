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
  // The name for the library being confirmed. Lives here rather than in the
  // confirmation itself, because the button that submits it is the same button
  // that asked for it — one row up, and deliberately unmoved.
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const pathFieldRef = useRef<HTMLInputElement>(null)
  // Covers the actions that are not plain mutations — the native picker and the
  // confirm step — which have no `isPending` of their own.
  const [hostBusy, setHostBusy] = useState(false)

  const rows = libraries.data ?? []
  const busy =
    hostBusy || create.isPending || register.isPending || probe.isPending || remove.isPending

  // Enter the name step, prefilled with the folder's own name.
  const askForName = (next: ConfirmState) => {
    setName(next.folderName)
    setConfirming(next)
  }

  // Leave it, putting the caret back where the flow started.
  const cancelConfirm = () => {
    setConfirming(null)
    setError(null)
    // The path field is remounted by this state change, so focus it afterwards
    // rather than relying on an `autoFocus` that also fires when the dialog
    // first opens.
    requestAnimationFrame(() => pathFieldRef.current?.focus())
  }

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
      askForName({
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
        askForName({ kind: 'pick', token: opened.token, folderName: opened.folderName ?? '' })
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

  const confirmNewLibrary = async (raw: string) => {
    const chosen = raw.trim()
    if (!confirming || !chosen || busy) return
    setError(null)
    setHostBusy(true)
    try {
      if (confirming.kind === 'pick') {
        // The shell holds the folder against this token; it never crossed into
        // this layer, and a token a later pick superseded is refused.
        await confirmPickedLibrary(confirming.token, chosen)
      } else {
        const added = await create.mutateAsync({
          root_path: confirming.path,
          display_name: chosen,
          create_if_missing: confirming.createFolder,
        })
        onSelect?.(added.id)
      }
      onClose()
    } catch (failure) {
      setError(confirming.kind === 'pick' ? hostOperationErrorMessage(failure) : messageOf(failure))
    } finally {
      setHostBusy(false)
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
        // `--menus`: this dialog's suggestion menu must be able to escape it.
        className="modal modal--menus"
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

        {/* The confirmation swaps this row's *contents* rather than replacing
            the section: same label line, same single row, same trailing hint
            line. The primary button therefore stays exactly where the click
            that asked for the confirmation left the pointer, and nothing above
            the row moves. */}
        <form
          className="lib-add"
          onSubmit={(event) => {
            event.preventDefault()
            void (confirming ? confirmNewLibrary(name) : submitPath())
          }}
        >
          <label className="field-label" htmlFor={confirming ? 'new-library-name' : 'library-path'}>
            {confirming ? 'Name' : 'Add library'}
          </label>
          {/* One row, so the suggestion menu — which stays open to drill down —
              drops over the hint text below rather than over the action it
              would otherwise swallow the click for. */}
          <div className="lib-add__row">
            {confirming ? (
              <input
                id="new-library-name"
                className="edit"
                value={name}
                onChange={(event) => setName(event.target.value)}
                aria-label="Library name"
                // Focused and selected, so the prefilled folder name is one
                // keystroke away from being replaced and Enter confirms it.
                autoFocus
                onFocus={(event) => event.target.select()}
                spellCheck={false}
              />
            ) : (
              <PathInput
                fieldRef={pathFieldRef}
                value={path}
                onChange={setPath}
                onSubmit={() => void submitPath()}
              />
            )}
            {confirming ? (
              <button type="button" className="btn" onClick={cancelConfirm} disabled={busy}>
                Cancel
              </button>
            ) : (
              isDesktopHost() && (
                <button type="button" className="btn" onClick={() => void browse()} disabled={busy}>
                  Browse…
                </button>
              )
            )}
            <button
              className="btn btn--primary"
              disabled={busy || !(confirming ? name.trim() : path.trim())}
            >
              {confirming ? 'Create library' : 'Add library'}
            </button>
          </div>
          <p className="lib-add__hint">
            {confirming
              ? newLibraryAsk(confirming)
              : 'An absolute path on the server. An existing library is added as it is; any other folder is offered as a new one.'}
          </p>

          {error && <div className="modal__error">{error}</div>}
        </form>
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

/** What confirming will actually do, in one sentence. */
function newLibraryAsk(target: ConfirmState): string {
  if (target.kind === 'pick') {
    return `“${target.folderName}” isn’t a Cairndex library. Confirming creates a new one there.`
  }
  if (target.createFolder) {
    return `${target.path} doesn’t exist yet. Confirming creates the folder and a new library in it.`
  }
  return `${target.path} isn’t a Cairndex library. Confirming creates a new one there.`
}

/**
 * The name step as a dialog of its own, for first-run setup.
 *
 * Everywhere else the File menu opens the Libraries dialog and the question is
 * asked in place (see the add form above), because there the pointer is already
 * on the button. First run is the one state without that dialog — it lists a
 * server's libraries and there is no server yet — so the menu picks a folder
 * directly there and this asks the same question on its own.
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
  const [name, setName] = useState(folderName)
  const trimmed = name.trim()

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
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (trimmed && !busy) onConfirm(trimmed)
          }}
        >
          <label className="field-label" htmlFor="picked-library-name">
            Name
          </label>
          <input
            id="picked-library-name"
            className="edit"
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-label="Library name"
            autoFocus
            onFocus={(event) => event.target.select()}
            spellCheck={false}
          />
          <p className="lib-add__hint">{newLibraryAsk({ kind: 'pick', token: '', folderName })}</p>
          <div className="modal__actions">
            <span className="toolbar__spacer" />
            <button type="button" className="btn" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
            <button className="btn btn--primary" disabled={busy || !trimmed}>
              Create library
            </button>
          </div>
        </form>
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

// Mirrors `.path-input__menu`'s max-height, plus its offset from the field. Used
// only to decide which side has room; the menu's real size stays CSS's business.
const MENU_MAX_HEIGHT = 226

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
  fieldRef,
}: {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  /** Lets the caller put focus back here after leaving the name step. */
  fieldRef: React.RefObject<HTMLInputElement | null>
}) {
  const [suggestions, setSuggestions] = useState<PathSuggestion[]>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  // Whether the menu opens upward. The add row is the last thing in the modal,
  // so "below the field" is usually the one direction with no room.
  const [dropUp, setDropUp] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const inputRef = fieldRef
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
    // Capture phase, not bubble. The dialog around this input stops mousedown
    // from propagating — that is how a click inside it avoids reaching the
    // backdrop and closing the whole modal — so a bubble-phase listener here
    // never sees a click anywhere in the dialog, which is precisely where a
    // user clicks to dismiss the menu. Capture runs on the way down, before
    // anything can stop it.
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [])

  // Keeps the keyboard-active option visible in the scrolling menu.
  useEffect(() => {
    if (active < 0) return
    menuRef.current?.children[active]?.scrollIntoView({ block: 'nearest' })
  }, [active])

  // Choose the direction with room, measured against the viewport rather than
  // the modal: the menu is allowed to overhang the dialog, but never the window.
  // Re-measured on every open and whenever the list changes, since both the
  // field's position and the menu's height move.
  useEffect(() => {
    if (!open || suggestions.length === 0) return
    const field = inputRef.current
    if (!field) return
    const { top, bottom } = field.getBoundingClientRect()
    const below = window.innerHeight - bottom
    setDropUp(below < MENU_MAX_HEIGHT && top > below)
  }, [open, suggestions, inputRef])

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
        ref={inputRef}
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
        <div
          className={`path-input__menu${dropUp ? ' path-input__menu--up' : ''}`}
          role="listbox"
          id="path-suggestions"
          ref={menuRef}
        >
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

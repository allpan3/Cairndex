import { getConnectionScopeKey } from '../api/requestScope'
import { useEffect, useId, useRef, useState } from 'react'
import { captureRequestScope } from '../api/requestScope'
import { InfoTip } from './InfoTip'
import { LibrarySettingsDialog } from './LibraryPrivateControls'
import { LibraryConversionDialog } from './LibraryConversionDialog'
import { READ_ONLY_SERVER, WriteModeConfirm, WriteModeToggle } from './LibraryWriteMode'
import {
  conversionStorageKey,
  conversionVisible,
  emptyConversion,
  readConversion,
  saveConversion,
  saveConversionVisible,
  type ConversionHistory,
} from '../api/libraryConversion'
import { useModalDialog } from './useModalDialog'

import {
  type LibraryRead,
  type PathSuggestion,
  PassphraseRequiredError,
  fetchPathSuggestions,
} from '../api/client'
import {
  useDeploymentWriteMode,
  useLibraries,
  useLibraryMutations,
  useLibraryOwnership,
  useLibraryServing,
  useWriteModeMutation,
} from '../api/hooks'
import {
  activeConnectionLabel,
  getActiveConnection,
  queueLibraryIndex,
} from '../desktop/connections'
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
  onCreated,
  onRemoved,
}: {
  onClose: () => void
  /** Make one library active — after adding it, or after selecting an existing one. */
  onSelect?: (libraryId: string) => void
  /**
   * A folder has just *become* a library, so it holds nothing yet and wants
   * indexing. Not fired for registering a library that already exists: that one
   * arrives with its own database, and re-reading a multi-terabyte tree
   * unasked is exactly what the ⟳ Update button is for.
   */
  onCreated?: (libraryId: string) => void
  /** A library left the registry, so its cached content must not outlive it. */
  onRemoved?: (libraryId: string) => void
}) {
  const libraries = useLibraries()
  const { create, register, probe, remove } = useLibraryMutations()
  const deployment = useDeploymentWriteMode()
  const titleId = useId()
  const readOnlyNote = useId()

  // The library whose settings are open over this dialog. Plain state, so it
  // lasts as long as the dialog does — not across a reload, and not into
  // another server.
  const [settingsId, setSettingsId] = useState<string | null>(null)
  // The Settings… button that opened them. Closing returns focus there even
  // where a click does not focus a button (WebKit, so the desktop app).
  const settingsOpener = useRef<HTMLElement | null>(null)

  const [path, setPath] = useState('')
  const [confirming, setConfirming] = useState<ConfirmState | null>(null)
  // The name for the library being confirmed. Lives here rather than in the
  // confirmation itself, because the button that submits it is the same button
  // that asked for it — one row up, and deliberately unmoved.
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [addedLibrary, setAddedLibrary] = useState<AddedLibrary | null>(null)
  const pathFieldRef = useRef<HTMLInputElement>(null)
  // Covers the actions that are not plain mutations — the native picker and the
  // confirm step — which have no `isPending` of their own.
  const [hostBusy, setHostBusy] = useState(false)
  const conversionKey = conversionStorageKey(getConnectionScopeKey())
  const [conversionHistory, setConversionHistory] = useState(() => readConversion(conversionKey))
  const [conversion, setConversionState] = useState<{ root: string | null } | null>(() =>
    conversionVisible(conversionKey) ? { root: null } : null,
  )
  const setConversion = (value: { root: string | null } | null) => {
    // A registry refresh can remount this dialog. Keep its visibility, never its path.
    saveConversionVisible(conversionKey, value !== null)
    setConversionState(value)
  }
  const rememberConversion = (history: ConversionHistory) => {
    saveConversion(conversionKey, history)
    setConversionHistory(history)
  }
  const convert = (root: string) => {
    rememberConversion(emptyConversion)
    setConversion({ root })
  }

  const rows = libraries.data ?? []
  // A legacy row has neither settings nor the switch, so it opens nothing here
  const settingsLibrary = conversion
    ? undefined
    : rows.find((row) => row.id === settingsId && row.package_format !== 'cairndex.library')
  // Said once for the list rather than on every disabled switch
  const readOnly =
    deployment === 'disabled' && rows.some((row) => row.package_format !== 'cairndex.library')
  const listUnavailable = libraries.isError && !addedLibrary
  const busy =
    hostBusy || create.isPending || register.isPending || probe.isPending || remove.isPending
  // A staged pick of an existing library: confirming *registers* it (its own
  // manifest carries the name), so the name field is read-only and the primary
  // button reads Add rather than Create.
  const addingLibrary = confirming?.kind === 'pick' && confirming.isLibrary

  // Enter the name step, prefilled with the folder's own name.
  const askForName = (next: ConfirmState) => {
    setName(next.folderName)
    setConfirming(next)
  }

  // Leave it, putting the caret back where the flow started.
  const cancelConfirm = () => {
    setConfirming(null)
    setAddedLibrary(null)
    setError(null)
    // The path field is remounted by this state change, so focus it afterwards
    // rather than relying on an `autoFocus` that also fires when the dialog
    // first opens.
    requestAnimationFrame(() => pathFieldRef.current?.focus())
  }

  // Refresh a committed native add without ever offering its mutation again.
  const refreshAddedLibrary = async (added: AddedLibrary) => {
    setAddedLibrary(added)
    setError(null)
    setHostBusy(true)
    try {
      const refreshed = await libraries.refetch()
      if (!refreshed.isSuccess) {
        setError('The library was added, but the library list could not be refreshed.')
        return
      }
      cancelConfirm()
    } catch {
      setError('The library was added, but the library list could not be refreshed.')
    } finally {
      setHostBusy(false)
    }
  }

  // Resolve one typed path into the single action it implies.
  const submitPath = async () => {
    const trimmed = path.trim()
    if (!trimmed || busy || listUnavailable) return
    setError(null)
    try {
      const found = await probe.mutateAsync(trimmed)
      if (found.needs_conversion) {
        convert(trimmed)
        return
      }
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
  //
  // A natively-picked folder is always a *local*-server library. On the local
  // connection, picking it *adds* it — the list refreshes and the dialog stays
  // open, so adding is not the same as switching, and Browse mirrors the typed
  // path (pick, then an explicit Add). Only a remote connection has to adopt
  // (switch to the local server), because the folder cannot otherwise join the
  // list being shown; that path keeps the old switch-and-close behaviour.
  const browse = async () => {
    if (busy) return
    setError(null)
    setHostBusy(true)
    // An old-library pick switches a remote connection to the local server
    const onLocal = getActiveConnection()?.kind !== 'remote'
    try {
      // `stage: true` — the shell parks the pick instead of adding it, so Browse
      // only picks a folder and the deliberate Add is the confirm step below.
      const { opened } = await openLibraryFolder(
        getActiveConnection()?.kind === 'remote'
          ? []
          : rows.map((library) => library.library_uuid).filter(Boolean),
        { stage: true },
      )
      if (!opened) return // cancelled — nothing changed
      if (opened.needsConversion) {
        // An old library: the local server is inspecting it. On a remote
        // connection the app switched there and this dialog remounts with the
        // review; here, show it now
        if (onLocal && opened.conversionTask) {
          rememberConversion({ ...emptyConversion, task: opened.conversionTask })
          setConversion({ root: null })
        }
        return
      }
      if (opened.needsConfirmation && opened.token) {
        // A plain folder to name, or a library to add: both go to the confirm
        // step, where the button reads Create or Add accordingly.
        askForName({
          kind: 'pick',
          token: opened.token,
          folderName: opened.folderName ?? '',
          isLibrary: opened.isLibrary,
        })
        return
      }
      if (opened.alreadyAvailable) {
        // Not an add — the current server already has it, so go to it.
        const here = rows.find((library) => library.library_uuid === opened.libraryUuid)
        if (here?.package_format === 'cairndex.library') {
          convert(here.root_path)
          return
        }
        if (here) onSelect?.(here.id)
        onClose()
      }
      // A staged pick always needs confirmation, so there is no other outcome.
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
    if (confirming.kind === 'pick') {
      // The shell holds the folder against this token; it never crossed into
      // this layer, and a token a later pick superseded is refused.
      const adopt = getActiveConnection()?.kind === 'remote'
      const becomingALibrary = !confirming.isLibrary
      setHostBusy(true)
      try {
        const { opened } = await confirmPickedLibrary(confirming.token, chosen, { adopt })
        // A picked *folder* is new to Cairndex and holds nothing; a picked
        // library arrives with its own database and is left alone.
        if (becomingALibrary && opened?.libraryId) {
          if (adopt) queueLibraryIndex('local', opened.libraryId)
          else onCreated?.(opened.libraryId)
        }
      } catch (failure) {
        setError(hostOperationErrorMessage(failure))
        return
      } finally {
        setHostBusy(false)
      }
      if (!adopt) {
        // Registration is already committed. Only the list read is retryable.
        await refreshAddedLibrary({ name: chosen })
        return
      }
      onClose()
      return
    }

    setHostBusy(true)
    try {
      const added = await create.mutateAsync({
        root_path: confirming.path,
        display_name: chosen,
        create_if_missing: confirming.createFolder,
      })
      onSelect?.(added.id)
      onCreated?.(added.id)
      onClose()
    } catch (failure) {
      setError(messageOf(failure))
    } finally {
      setHostBusy(false)
    }
  }

  const removeLibrary = (libraryId: string) => {
    setError(null)
    const assertScope = captureRequestScope(false)
    // The registry refresh can remount this dialog before per-observer callbacks run
    void remove
      .mutateAsync(libraryId)
      .then(() => {
        assertScope()
        onRemoved?.(libraryId)
      })
      .catch((failure: unknown) => {
        try {
          assertScope()
        } catch {
          return
        }
        setError(messageOf(failure))
      })
  }

  const openSettings = (libraryId: string, opener: HTMLElement) => {
    settingsOpener.current = opener
    setSettingsId(libraryId)
  }
  const closeSettings = () => {
    setSettingsId(null)
    requestAnimationFrame(() => {
      if (settingsOpener.current?.isConnected) settingsOpener.current.focus()
    })
  }

  const { ref: dialogRef, close: closeDialog } = useModalDialog(
    confirming ? cancelConfirm : onClose,
    busy,
  )

  return (
    <>
      <div
        className="modal-backdrop"
        onMouseDown={closeDialog}
        // Hidden rather than unmounted behind the conversion review or a
        // library's settings, so a typed path or name step survives them
        style={conversion || settingsLibrary ? { display: 'none' } : undefined}
      >
        <div
          // `--menus`: this dialog's suggestion menu must be able to escape it.
          className="modal modal--menus"
          onMouseDown={(e) => e.stopPropagation()}
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
        >
          <div className="modal__head">
            <h2 id={titleId}>Libraries</h2>
            <button className="modal__close" onClick={closeDialog} aria-label="Close">
              ×
            </button>
          </div>

          <p className="lib-add__hint">
            Libraries served by {activeConnectionLabel()}
            {readOnly && (
              <>
                . <span id={readOnlyNote}>{READ_ONLY_SERVER}</span>
              </>
            )}
          </p>
          {conversionHistory.task && (
            <button className="btn" onClick={() => setConversion({ root: null })}>
              Resume conversion
            </button>
          )}
          <div className="lib-list">
            {libraries.isPending && <div className="inspector__empty">Loading libraries…</div>}
            {libraries.isError && libraries.data === undefined && (
              <LibraryListError
                message="The library list could not be loaded."
                retrying={libraries.isFetching}
                onRetry={() => void libraries.refetch()}
              />
            )}
            {libraries.isSuccess && rows.length === 0 && (
              <div className="inspector__empty">No libraries yet. Add one below.</div>
            )}
            {rows.map((library) => (
              <LibraryRow
                key={library.id}
                library={library}
                busy={busy}
                deployment={deployment}
                readOnlyNote={readOnly ? readOnlyNote : undefined}
                onRemove={() => removeLibrary(library.id)}
                onConvert={() => convert(library.root_path)}
                onSettings={(opener) => openSettings(library.id, opener)}
                onSelect={() => {
                  onSelect?.(library.id)
                  onClose()
                }}
              />
            ))}
            {libraries.isError && libraries.data !== undefined && !addedLibrary && (
              <LibraryListError
                message="The library list could not be refreshed."
                retrying={libraries.isFetching}
                onRetry={() => void libraries.refetch()}
              />
            )}
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
              void (addedLibrary
                ? refreshAddedLibrary(addedLibrary)
                : confirming
                  ? confirmNewLibrary(name)
                  : submitPath())
            }}
          >
            <label
              className="field-label"
              htmlFor={confirming ? 'new-library-name' : 'library-path'}
            >
              {confirming ? (addingLibrary ? 'Library' : 'Name') : 'Add library'}
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
                  // An existing library keeps the name from its own manifest, so
                  // the field is read-only there — it shows what will be added
                  // rather than inviting an edit that registration would ignore.
                  readOnly={addingLibrary || Boolean(addedLibrary)}
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
              {confirming && !addedLibrary ? (
                <button type="button" className="btn" onClick={cancelConfirm} disabled={busy}>
                  Cancel
                </button>
              ) : !confirming ? (
                isDesktopHost() && (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void browse()}
                    disabled={busy}
                  >
                    Browse…
                  </button>
                )
              ) : null}
              <button
                className="btn btn--primary"
                disabled={
                  busy ||
                  (listUnavailable && confirming?.kind !== 'pick') ||
                  (!addedLibrary && !(confirming ? name.trim() : path.trim()))
                }
              >
                {addedLibrary
                  ? hostBusy
                    ? 'Refreshing…'
                    : 'Retry refresh'
                  : confirming
                    ? addingLibrary
                      ? 'Add library'
                      : 'Create library'
                    : 'Add library'}
              </button>
            </div>
            <p className="lib-add__hint">
              {addedLibrary ? (
                `“${addedLibrary.name}” was added. Refresh the list to finish.`
              ) : confirming ? (
                newLibraryAsk(confirming)
              ) : (
                <>
                  A folder on {activeConnectionLabel()}.{' '}
                  <InfoTip label="About adding a library">
                    An existing library is added under its own name. Any other folder becomes a new
                    library after you confirm its name.
                  </InfoTip>
                </>
              )}
            </p>

            {/* Browse always picks on This Computer. Only from another server is
                that a different place, and adding there switches servers. */}
            {isDesktopHost() && getActiveConnection()?.kind === 'remote' && (
              <p className="lib-add__hint">
                Browse… adds a folder on This Computer and switches to it.
              </p>
            )}
            {error && <div className="modal__error">{error}</div>}
          </form>
        </div>
      </div>
      {settingsLibrary && (
        <LibrarySettingsDialog library={settingsLibrary} onClose={closeSettings} />
      )}
      {conversion && (
        <LibraryConversionDialog
          root={conversion.root}
          history={conversionHistory}
          remember={rememberConversion}
          onClose={() => {
            setConversion(null)
            void libraries.refetch()
          }}
          onOpen={(id) => {
            setConversion(null)
            onSelect?.(id)
            onClose()
          }}
        />
      )}
    </>
  )
}

/** A folder awaiting a name, from either entry path. */
type ConfirmState =
  | { kind: 'path'; path: string; createFolder: boolean; folderName: string }
  // `token` stands in for the folder the shell picked and is holding; the path
  // itself never enters this layer (see `mappings::PickedFolder`). `isLibrary`
  // decides whether confirming registers an existing library or creates one.
  | { kind: 'pick'; token: string; folderName: string; isLibrary: boolean }

/** A native add that is committed while its list refresh remains pending. */
type AddedLibrary = { name: string }

/** Distinguishes a failed library read from a successful empty list. */
function LibraryListError({
  message,
  retrying,
  onRetry,
}: {
  message: string
  retrying: boolean
  onRetry: () => void
}) {
  return (
    <div className="inspector__empty" role="alert">
      <div>{message}</div>
      <button type="button" className="btn" onClick={onRetry} disabled={retrying}>
        {retrying ? 'Retrying…' : 'Retry'}
      </button>
    </div>
  )
}

/** What confirming will actually do, in one sentence. */
function newLibraryAsk(target: ConfirmState): string {
  if (target.kind === 'pick') {
    return target.isLibrary
      ? `“${target.folderName}” is a Cairndex library. Confirming adds it to This Computer.`
      : `“${target.folderName}” isn’t a Cairndex library. Confirming creates a new one there.`
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
  isLibrary,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  folderName: string
  /** Whether the picked folder already holds a library — the sentence below
   *  differs, and guessing it would tell the owner the wrong thing. */
  isLibrary: boolean
  busy: boolean
  error: string | null
  onConfirm: (name: string) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(folderName)
  const trimmed = name.trim()

  const { ref: dialogRef, close: closeDialog } = useModalDialog(onCancel, busy)

  return (
    <div className="modal-backdrop" onMouseDown={closeDialog}>
      <div
        className="modal"
        onMouseDown={(event) => event.stopPropagation()}
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
      >
        <div className="modal__head">
          <h2>Add library</h2>
          <button className="modal__close" onClick={closeDialog} aria-label="Close">
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
          <p className="lib-add__hint">
            {newLibraryAsk({ kind: 'pick', token: '', folderName, isLibrary })}
          </p>
          <div className="modal__actions">
            <span className="toolbar__spacer" />
            <button type="button" className="btn" onClick={closeDialog} disabled={busy}>
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
  deployment,
  readOnlyNote,
  onRemove,
  onSelect,
  onConvert,
  onSettings,
}: {
  library: LibraryRead
  busy: boolean
  /** The deployment master switch (ADR-0013 §1); `undefined` until known. */
  deployment: 'allowed' | 'disabled' | undefined
  /** The dialog's sentence saying why every switch is off, when one applies. */
  readOnlyNote?: string
  onRemove: () => void
  onSelect: () => void
  onConvert: () => void
  /** Opens this library's settings; `opener` gets focus back when they close. */
  onSettings: (opener: HTMLElement) => void
}) {
  // At most one confirmation is open, because each asks about this row and
  // replaces it. Turning write mode off asks only when the server wants the
  // passphrase.
  const [asking, setAsking] = useState<'remove' | 'write-on' | 'write-off' | null>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const available = library.status === 'available'
  const legacy = library.package_format === 'cairndex.library'
  const ownership = useLibraryOwnership(legacy ? null : library.id)
  const serving = useLibraryServing(legacy ? null : library.id)
  const writeMode = useWriteModeMutation()
  const released = ownership.data?.state === 'locally_released'
  // A passphrase request opens the step below; anything else is said here and
  // the switch stays live, so clicking it again retries.
  const writeModeError =
    writeMode.error && !(writeMode.error instanceof PassphraseRequiredError)
      ? writeMode.error.message
      : null

  const finishWriteMode = () => {
    setAsking(null)
    // The step replaced the switch, so put focus back on it once it returns
    requestAnimationFrame(() => toggleRef.current?.focus())
  }
  const toggleWriteMode = () => {
    if (!library.write_mode_enabled) {
      setAsking('write-on')
      return
    }
    writeMode.mutate(
      { libraryId: library.id, enabled: false },
      {
        onError: (failure) => {
          if (failure instanceof PassphraseRequiredError) setAsking('write-off')
        },
      },
    )
  }

  if (asking === 'write-on' || asking === 'write-off') {
    return (
      <WriteModeConfirm library={library} enable={asking === 'write-on'} onDone={finishWriteMode} />
    )
  }

  if (asking === 'remove') {
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
        <button className="btn btn--sm" onClick={() => setAsking(null)} disabled={busy}>
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
        {released && <span className="lib-row__note">Released on this server</span>}
        {writeModeError && (
          <span className="lib-row__note" role="alert">
            {writeModeError}
          </span>
        )}
      </div>
      {/* Only a problem is shown: an available library is the normal case */}
      {!available && <span className="badge badge--warn">Unavailable</span>}
      {serving.error && <span role="alert">{serving.error.message}</span>}
      <button
        className="btn btn--sm"
        disabled={busy}
        onClick={legacy ? onConvert : onSelect}
        aria-label={`${legacy ? 'Convert' : 'Open'} ${library.name}`}
        title={
          legacy
            ? 'Convert this library from an earlier version of Cairndex'
            : 'Show this library in the browser'
        }
      >
        {legacy ? 'Convert' : 'Open'}
      </button>
      <button
        className="btn btn--sm"
        disabled={legacy || busy || serving.isPending}
        title={
          released
            ? 'Serve this library here again'
            : 'Stop serving this library here, so that another computer can open it. Nothing is deleted.'
        }
        onClick={() => serving.mutate(released ? 'reopen' : 'release')}
      >
        {serving.isPending ? 'Working…' : released ? 'Reopen' : 'Release'}
      </button>
      {/* An old-format library converts first; it has no write mode to show */}
      {!legacy && (
        <WriteModeToggle
          library={library}
          deployment={deployment}
          released={released}
          disabled={busy || writeMode.isPending}
          describedBy={library.write_mode_enabled ? undefined : readOnlyNote}
          toggleRef={toggleRef}
          onClick={toggleWriteMode}
        />
      )}
      <button
        className="btn btn--sm"
        disabled={legacy || busy}
        aria-label={`Settings for ${library.name}`}
        title="Passphrase, private backups and recovery"
        onClick={(event) => onSettings(event.currentTarget)}
      >
        Settings…
      </button>
      <button
        className="btn btn--sm"
        onClick={() => setAsking('remove')}
        disabled={busy}
        aria-label={`Remove ${library.name}`}
        title="Remove this library from the list. The folder and its files are not touched."
      >
        Remove
      </button>
    </div>
  )
}

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

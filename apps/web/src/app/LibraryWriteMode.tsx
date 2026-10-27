import { useState, type Ref } from 'react'

import { PassphraseRequiredError, type LibraryRead } from '../api/client'
import { useWriteModeMutation } from '../api/hooks'

export const READ_ONLY_SERVER = 'This server does not allow write mode.'
// Named as the file-operations panel names what this switch allows
const TURN_ON = 'Turn on file operations for this library on this server'
const TURN_OFF = 'Turn off file operations for this library on this server'
// The portable format with the complete catalog that source operations need.
// The server refuses any other in both directions (`gate.set_write_mode`).
const WRITE_MODE_FORMAT = 3

/** Why write mode cannot be changed here, or `null` when it can. */
function blockedReason(
  library: LibraryRead,
  deployment: 'allowed' | 'disabled' | undefined,
  released: boolean,
): string | null {
  // The server reads the library's own manifest to change the switch either way
  if (library.status !== 'available') return 'Reconnect this library to change write mode.'
  if (library.schema_version !== WRITE_MODE_FORMAT)
    return 'Write mode needs the current library format.'
  // Turning off stays possible: the flag is the owner's to clear
  if (library.write_mode_enabled) return null
  if (deployment === 'disabled') return READ_ONLY_SERVER
  if (deployment === undefined) return 'Checking whether this server allows write mode…'
  // Source operations stop while this server does not serve the library, so
  // turning them on waits for Reopen rather than taking effect unseen later
  if (released) return 'Reopen this library here to turn on write mode.'
  return null
}

/**
 * The write-mode switch for one library row (ADR-0013 §1, ADR-0036): the
 * owner's opt-in on this server. Source operations need it and the
 * deployment's permission.
 *
 * Turning it **off** is one click — giving up a capability needs no
 * confirmation. Turning it **on** goes through `WriteModeConfirm`. When it
 * cannot be turned on the switch is disabled and says why rather than
 * disappearing: a missing switch reads as a missing feature.
 */
export function WriteModeToggle({
  library,
  deployment,
  released,
  disabled,
  describedBy,
  toggleRef,
  onClick,
}: {
  library: LibraryRead
  deployment: 'allowed' | 'disabled' | undefined
  released: boolean
  disabled: boolean
  describedBy?: string
  toggleRef: Ref<HTMLButtonElement>
  onClick: () => void
}) {
  const enabled = library.write_mode_enabled
  const blocked = blockedReason(library, deployment, released)
  return (
    <button
      ref={toggleRef}
      className={`btn btn--sm${enabled && deployment === 'allowed' ? ' btn--active' : ''}`}
      aria-pressed={enabled}
      aria-label={`Write mode for ${library.name}`}
      aria-describedby={describedBy}
      title={blocked ?? (enabled ? TURN_OFF : TURN_ON)}
      disabled={disabled || blocked !== null}
      onClick={onClick}
    >
      {/* An enabled flag the deployment is overriding is stated as exactly
          that, rather than silently rendered as off. */}
      Write mode: {enabled ? (deployment === 'disabled' ? 'on (blocked)' : 'on') : 'off'}
    </button>
  )
}

/**
 * Confirms a write-mode change in place of the row, with the passphrase when
 * the server asks for it.
 *
 * The field appears only after the server asks, so an unprotected library is
 * one click and a protected one is never guessed at. The same 401 covers a
 * wrong passphrase, which is why the field stays open with a message instead
 * of collapsing the step. Turning off reaches this step only after that 401: a
 * locked library's passphrase stands in for unlocking it first.
 */
export function WriteModeConfirm({
  library,
  enable,
  onDone,
}: {
  library: LibraryRead
  enable: boolean
  onDone: () => void
}) {
  const writeMode = useWriteModeMutation()
  const [passphrase, setPassphrase] = useState<string | null>(enable ? null : '')
  const [error, setError] = useState<string | null>(null)

  const submit = () => {
    if (writeMode.isPending || passphrase === '') return
    setError(null)
    writeMode.mutate(
      { libraryId: library.id, enabled: enable, passphrase: passphrase ?? undefined },
      {
        onSuccess: onDone,
        onError: (failure) => {
          if (failure instanceof PassphraseRequiredError) {
            // First ask: the field's own label is the explanation
            setError(passphrase === null ? null : 'That passphrase was not accepted.')
            setPassphrase(passphrase ?? '')
            return
          }
          // The step and its intent stay, so the same button retries
          setError(failure.message)
        },
      },
    )
  }

  return (
    <form
      className="lib-row lib-row--confirm"
      aria-label={`${enable ? 'Turn on' : 'Turn off'} write mode for ${library.name}`}
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || writeMode.isPending) return
        // Leaves this step, not the whole dialog
        event.preventDefault()
        onDone()
      }}
    >
      <div className="lib-row__main">
        <span className="lib-row__name">
          Turn {enable ? 'on' : 'off'} write mode for “{library.name}”?
        </span>
        <span className="lib-row__note">
          {enable
            ? 'Allows reviewed copy, rename, move and trash in this folder, on this server only.'
            : 'This library is locked here. Enter its passphrase to turn write mode off.'}
        </span>
        {passphrase !== null && (
          <input
            className="edit"
            type="password"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            aria-label={`Passphrase for ${library.name}`}
            placeholder="Library passphrase"
            autoFocus
            autoComplete="current-password"
          />
        )}
        {error && (
          <span className="lib-row__note" role="alert">
            {error}
          </span>
        )}
      </div>
      <button
        type="button"
        className="btn btn--sm"
        onClick={onDone}
        disabled={writeMode.isPending}
        // The safe choice takes focus from the switch this step replaced
        autoFocus={passphrase === null}
      >
        Cancel
      </button>
      <button
        className="btn btn--sm btn--primary"
        disabled={writeMode.isPending || passphrase === ''}
      >
        {writeMode.isPending ? 'Working…' : enable ? 'Turn on' : 'Turn off'}
      </button>
    </form>
  )
}

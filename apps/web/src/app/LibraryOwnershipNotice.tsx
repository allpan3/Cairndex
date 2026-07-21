import type { LibraryOwnership, LibraryRead } from '../api/client'
import { LibraryAccessNotice } from './LibraryAccessNotice'

/**
 * What a user sees when this server may not serve a library (ADR-0018 §3).
 *
 * Three outcomes, deliberately distinct:
 *
 * - a **live** holder is not something to take the library from — the useful
 *   action is to connect to that server, so no takeover is offered;
 * - a **stale** or **unreadable** lease offers a takeover, always confirmed,
 *   never automatic;
 * - a takeover in flight shows indeterminate progress, because the server
 *   watches the lease for longer than a heartbeat period before it may proceed.
 */

interface Props {
  ownership: LibraryOwnership
  libraries: LibraryRead[]
  libraryId: string
  onChangeLibrary: (id: string) => void
  onTakeOver: () => void
  onConnectTo: (serverUrl: string) => void
  takeoverPending: boolean
  takeoverError: string | null
}

function holderName(ownership: LibraryOwnership): string {
  return ownership.holder?.machine_name?.trim() || 'another server'
}

function lastSeen(ownership: LibraryOwnership): string | null {
  const at = ownership.holder?.heartbeat_at
  if (!at) return null
  const parsed = new Date(at)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toLocaleString()
}

export function LibraryOwnershipNotice({
  ownership,
  libraries,
  libraryId,
  onChangeLibrary,
  onTakeOver,
  onConnectTo,
  takeoverPending,
  takeoverError,
}: Props) {
  const running = ownership.takeover?.running === true || takeoverPending
  const who = holderName(ownership)
  const seen = lastSeen(ownership)

  if (running) {
    return (
      <LibraryAccessNotice
        libraries={libraries}
        libraryId={libraryId}
        onChangeLibrary={onChangeLibrary}
        title="Taking over this library…"
        message={`Checking that ${who} is really gone. This takes a couple of minutes: if that machine is still running, it will say so during the check and keep the library.`}
      >
        <span className="lockscreen__hint" role="status">
          Watching the ownership record…
        </span>
      </LibraryAccessNotice>
    )
  }

  if (ownership.can_take_over) {
    return (
      <LibraryAccessNotice
        libraries={libraries}
        libraryId={libraryId}
        onChangeLibrary={onChangeLibrary}
        title="This library was left open elsewhere"
        message={
          ownership.state === 'unreadable'
            ? "This library's ownership record could not be read. Serve it here only if no other machine is using it."
            : `${who} did not close this library${seen ? `, last seen ${seen}` : ''}. Serving it in two places at once can lose data, so this needs your confirmation.`
        }
      >
        <button className="lockscreen__submit" onClick={onTakeOver}>
          Serve here anyway
        </button>
        {takeoverError && (
          <p className="lockscreen__error" role="alert">
            {takeoverError}
          </p>
        )}
      </LibraryAccessNotice>
    )
  }

  // A live holder. Offer the redirect only when the holder advertises an address
  // another machine can actually reach — a loopback URL names the holder's own
  // machine and would send this user to their own server.
  return (
    <LibraryAccessNotice
      libraries={libraries}
      libraryId={libraryId}
      onChangeLibrary={onChangeLibrary}
      title={`This library is open on ${who}`}
      message={
        ownership.redirect_url
          ? `Cairndex serves a library from one machine at a time. ${who} has it open at ${ownership.redirect_url}.`
          : `Cairndex serves a library from one machine at a time. Close it on ${who} first, then try again.`
      }
    >
      {ownership.redirect_url && (
        <button className="lockscreen__submit" onClick={() => onConnectTo(ownership.redirect_url!)}>
          Connect to {who}
        </button>
      )}
    </LibraryAccessNotice>
  )
}

import { useEffect, useState } from 'react'

import type { LibraryOwnership, LibraryRead } from '../api/client'
import { LibraryAccessNotice } from './LibraryAccessNotice'
import { OwnershipConnectionControls } from './OwnershipConnectionControls'

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
  onManage?: () => void
  onRetryRelease?: () => void
  onReopen?: () => void
  reopenPending?: boolean
  reopenError?: string | null
  onTakeOver: () => void
  onConnectTo: (serverUrl: string) => void
  takeoverPending: boolean
  takeoverError: string | null
  /** True while the redirect below is being followed. */
  connectPending?: boolean
  /** Why the last redirect attempt failed, if it did. */
  connectError?: string | null
}

/** "1 minute 20 seconds", "45 seconds" — no bare second counts past a minute. */
function humanDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds))
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes === 0) return `${rest} second${rest === 1 ? '' : 's'}`
  const minutePart = `${minutes} minute${minutes === 1 ? '' : 's'}`
  return rest === 0 ? minutePart : `${minutePart} ${rest} second${rest === 1 ? '' : 's'}`
}

/**
 * Seconds left in the observation window, ticking once a second.
 *
 * The wait is inherent — the server must watch the lease for longer than a
 * heartbeat period before it may proceed — so the honest thing is to show it
 * rather than spin silently for minutes. Returns null when the server did not
 * report timing, in which case the UI falls back to describing the wait without
 * a number.
 */
function useRemainingSeconds(startedAt: string | null, total: number | null): number | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!startedAt || total === null) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [startedAt, total])

  if (!startedAt || total === null) return null
  const started = new Date(startedAt).getTime()
  if (Number.isNaN(started)) return null
  return Math.max(0, total - (now - started) / 1000)
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
  onReopen,
  onRetryRelease,
  onManage,
  reopenPending = false,
  reopenError = null,
  onConnectTo,
  takeoverPending,
  takeoverError,
  connectPending = false,
  connectError = null,
}: Props) {
  const running = ownership.takeover?.running === true || takeoverPending
  const who = holderName(ownership)
  const seen = lastSeen(ownership)
  const remaining = useRemainingSeconds(
    ownership.takeover?.started_at ?? null,
    ownership.takeover?.observation_seconds ?? null,
  )

  const connectionControls = (
    <OwnershipConnectionControls
      key={`${libraryId}:${ownership.holder?.server_uuid ?? ''}`}
      holder={who}
      advertisedUrl={ownership.redirect_url}
      pending={connectPending}
      error={connectError}
      onConnectTo={onConnectTo}
    />
  )

  if (ownership.state === 'release_pending') {
    return (
      <LibraryAccessNotice
        libraries={libraries}
        libraryId={libraryId}
        onChangeLibrary={onChangeLibrary}
        title="Library release is not finished"
        message="This server is refusing new work and still holds ownership. Active work or database closure has not finished. Retry Release to finish the handoff."
      >
        <button className="lockscreen__submit" onClick={onRetryRelease} disabled={reopenPending}>
          {reopenPending ? 'Releasing…' : 'Retry Release'}
        </button>
        {reopenError && (
          <p className="lockscreen__error" role="alert">
            {reopenError}
          </p>
        )}
      </LibraryAccessNotice>
    )
  }

  if (
    !running &&
    (ownership.state === 'locally_released' || ownership.state === 'ownership_lost')
  ) {
    return (
      <LibraryAccessNotice
        libraries={libraries}
        libraryId={libraryId}
        onChangeLibrary={onChangeLibrary}
        title={
          ownership.state === 'locally_released'
            ? 'Library released on this server'
            : 'Library ownership changed'
        }
        message="This server stopped serving the library. Your files, metadata and registration remain. Reopen deliberately when you want this server to serve it again; the private store must be available."
      >
        <button className="lockscreen__submit" onClick={onReopen} disabled={reopenPending}>
          {reopenPending ? 'Reopening…' : 'Reopen'}
        </button>
        {onManage && (
          <button className="btn" onClick={onManage}>
            Manage libraries
          </button>
        )}
        {ownership.state !== 'locally_released' && connectionControls}
        {ownership.can_take_over && (
          <button className="lockscreen__submit" onClick={onTakeOver}>
            Confirm stale takeover
          </button>
        )}
        {reopenError && (
          <p className="lockscreen__error" role="alert">
            {reopenError}
          </p>
        )}
      </LibraryAccessNotice>
    )
  }

  if (ownership.state === 'ownership_uncertain') {
    return (
      <LibraryAccessNotice
        libraries={libraries}
        libraryId={libraryId}
        onChangeLibrary={onChangeLibrary}
        title="Checking library connection"
        message="Ownership could not be verified. This server has paused library work and will check again when storage is reachable. It will not take ownership from another server."
      />
    )
  }

  if (running) {
    const total = ownership.takeover?.observation_seconds ?? null
    return (
      <LibraryAccessNotice
        libraries={libraries}
        libraryId={libraryId}
        onChangeLibrary={onChangeLibrary}
        title="Taking over this library…"
        message={
          total === null
            ? `Watching this library's ownership record to check that ${who} is really gone. If that machine is still running it will write to the record during the check, and it keeps the library.`
            : `Watching this library's ownership record for ${humanDuration(total)} to check that ${who} is really gone. That is slightly longer than the gap between a running server's updates, so if ${who} is alive it will write during the check — and it keeps the library.`
        }
      >
        <span className="lockscreen__hint" role="status">
          {remaining === null
            ? 'Watching the ownership record…'
            : remaining > 0
              ? `About ${humanDuration(remaining)} left…`
              : 'Finishing up…'}
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

  // A live holder keeps ownership. Its advertised address is only a hint;
  // the client can select an alternative that works on its current network.
  return (
    <LibraryAccessNotice
      libraries={libraries}
      libraryId={libraryId}
      onChangeLibrary={onChangeLibrary}
      title={`This library is open on ${who}`}
      message={
        ownership.redirect_url
          ? `Cairndex serves a library from one machine at a time. ${who} has it open at ${ownership.redirect_url}.`
          : `Cairndex serves a library from one machine at a time. Connect to ${who} using an address available from this device, or close the library there first.`
      }
    >
      {connectionControls}
    </LibraryAccessNotice>
  )
}

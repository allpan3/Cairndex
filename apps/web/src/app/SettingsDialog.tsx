import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  pollDevicePairing,
  startDevicePairing,
  type DeviceRead,
  type LibraryRead,
} from '../api/client'
import { useDeviceMutations, useDevices } from '../api/hooks'
import { formatDateTime } from '../lib/format'
import {
  clearHostDeviceToken,
  getHostLabels,
  getHostPlatform,
  hasHostDeviceToken,
  saveHostDeviceToken,
} from '../platform'

const PAIR_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** Owner settings shell; Devices is the first global settings page. */
export function SettingsDialog({
  libraries,
  libraryId,
  startPairing = false,
  onClose,
}: {
  libraries: LibraryRead[]
  libraryId: string | null
  startPairing?: boolean
  onClose: () => void
}) {
  const desktop = getHostPlatform().kind === 'desktop'
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal settings-modal"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <div className="modal__head">
          <h2 id="settings-title">Settings</h2>
          <button className="modal__close" onClick={onClose} aria-label="Close settings">
            ×
          </button>
        </div>
        <div className="settings-layout">
          <nav className="settings-nav" aria-label="Settings pages">
            <button className="settings-nav__item settings-nav__item--active">Devices</button>
          </nav>
          {desktop ? (
            <PairThisDevice startPairing={startPairing} />
          ) : (
            <DevicesPage libraries={libraries} libraryId={libraryId} startPairing={startPairing} />
          )}
        </div>
      </div>
    </div>
  )
}

// Tracks one short-lived anonymous pairing request in the shell UI
interface PendingPairing {
  pairCode: string
  pollKey: string
  expiresAt: number
}

// Drives the anonymous device side of ADR-0015 pairing inside the shell
function PairThisDevice({ startPairing }: { startPairing: boolean }) {
  const queryClient = useQueryClient()
  const [paired, setPaired] = useState(hasHostDeviceToken)
  const [pending, setPending] = useState<PendingPairing | null>(null)
  const [phase, setPhase] = useState<'idle' | 'starting' | 'pending' | 'paired' | 'error'>(
    paired ? 'paired' : 'idle',
  )
  const [forgetting, setForgetting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const autoStarted = useRef(false)

  const beginPairing = useCallback(async () => {
    setError(null)
    setPending(null)
    setPhase('starting')
    try {
      const started = await startDevicePairing(getHostLabels().deviceName)
      setPending({
        pairCode: started.pair_code,
        pollKey: started.poll_key,
        expiresAt: Date.now() + 10 * 60 * 1000,
      })
      setPhase('pending')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not start device pairing.')
      setPhase('error')
    }
  }, [])

  useEffect(() => {
    if (!startPairing || autoStarted.current) return
    autoStarted.current = true
    void beginPairing()
  }, [beginPairing, startPairing])

  useEffect(() => {
    if (phase !== 'pending' || !pending) return
    const controller = new AbortController()
    let timeout = 0

    const poll = async () => {
      if (Date.now() >= pending.expiresAt) {
        setError('This pairing code expired. Start again to get a new code.')
        setPhase('error')
        return
      }
      try {
        const result = await pollDevicePairing(pending.pollKey, controller.signal)
        if (result.status === 'approved') {
          if (!result.token) throw new Error('The server approved pairing without a token.')
          if (!result.library_ids?.length)
            throw new Error('The server approved pairing without a library scope.')
          await saveHostDeviceToken(result.token, result.library_ids)
          setPaired(true)
          setPending(null)
          setPhase('paired')
          await queryClient.invalidateQueries()
          return
        }
        timeout = window.setTimeout(poll, 1000)
      } catch (caught) {
        if (controller.signal.aborted) return
        setError(caught instanceof Error ? caught.message : 'Could not finish device pairing.')
        setPhase('error')
      }
    }

    timeout = window.setTimeout(poll, 1000)
    return () => {
      controller.abort()
      window.clearTimeout(timeout)
    }
  }, [pending, phase, queryClient])

  const cancel = () => {
    setPending(null)
    setError(null)
    setPhase(paired ? 'paired' : 'idle')
  }

  const forgetPairing = async () => {
    setForgetting(true)
    setError(null)
    try {
      await clearHostDeviceToken()
      setPaired(false)
      setPending(null)
      setPhase('idle')
      await queryClient.invalidateQueries()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not forget this pairing.')
      setPhase('error')
    } finally {
      setForgetting(false)
    }
  }

  return (
    <section className="devices-page" aria-labelledby="devices-title">
      <div className="devices-page__head">
        <div>
          <h3 id="devices-title">This device</h3>
          <p>Pair this desktop shell with an owner-approved set of libraries.</p>
        </div>
        {(phase === 'idle' || phase === 'paired' || phase === 'error') && (
          <div className="devices-page__actions">
            {paired && (
              <button className="btn" onClick={() => void forgetPairing()} disabled={forgetting}>
                {forgetting ? 'Forgetting…' : 'Forget pairing'}
              </button>
            )}
            <button className="btn btn--primary" onClick={() => void beginPairing()}>
              {paired ? 'Pair again' : 'Pair this device'}
            </button>
          </div>
        )}
      </div>

      {phase === 'starting' && <div className="inspector__empty">Starting pairing…</div>}

      {phase === 'pending' && pending && (
        <div className="pair-this-device" aria-live="polite">
          <p>On an unlocked Cairndex web session, open Settings → Devices and enter:</p>
          <output className="pair-this-device__code" aria-label="Pairing code">
            {pending.pairCode}
          </output>
          <p>Waiting for approval. This code expires after ten minutes.</p>
          <button className="btn btn--compact" onClick={cancel}>
            Cancel
          </button>
        </div>
      )}

      {paired && (phase === 'paired' || phase === 'error') && (
        <div className="pair-device__success" role="status">
          This device is paired for its approved libraries. Forgetting removes the local token;
          revoke the device from an owner web session to invalidate it on the server.
        </div>
      )}

      {error && (
        <div className="modal__error" role="alert">
          {error}
        </div>
      )}
    </section>
  )
}

/** Pair, audit, and revoke native-client device credentials. */
function DevicesPage({
  libraries,
  libraryId,
  startPairing,
}: {
  libraries: LibraryRead[]
  libraryId: string | null
  startPairing: boolean
}) {
  const [pairing, setPairing] = useState(startPairing)
  const [pairCode, setPairCode] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () =>
      new Set(
        libraryId &&
          libraries.some((library) => library.id === libraryId && library.status === 'available')
          ? [libraryId]
          : [],
      ),
  )
  const [approved, setApproved] = useState(false)
  const [awaitingDevice, setAwaitingDevice] = useState(false)
  const [deviceCountAtApproval, setDeviceCountAtApproval] = useState<number | null>(null)
  const devices = useDevices(awaitingDevice, deviceCountAtApproval)
  const mutations = useDeviceMutations()
  const libraryNames = useMemo(
    () => new Map(libraries.map((library) => [library.id, library.name])),
    [libraries],
  )
  const availableIds = useMemo(
    () =>
      new Set(
        libraries.filter((library) => library.status === 'available').map((library) => library.id),
      ),
    [libraries],
  )
  const selectedAvailableIds = [...selectedIds].filter((id) => availableIds.has(id))

  const toggleLibrary = (id: string) => {
    setSelectedIds((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const submitPairing = () => {
    setApproved(false)
    mutations.approve.mutate(
      { pairCode, libraryIds: selectedAvailableIds },
      {
        onSuccess: () => {
          setApproved(true)
          setPairCode('')
          setDeviceCountAtApproval(devices.data?.length ?? 0)
          setAwaitingDevice(true)
          mutations.approve.reset()
        },
      },
    )
  }

  const togglePairing = () => {
    mutations.approve.reset()
    setPairCode('')
    setApproved(false)
    setAwaitingDevice(false)
    setDeviceCountAtApproval(null)
    setPairing((visible) => !visible)
  }

  return (
    <section className="devices-page" aria-labelledby="devices-title">
      <div className="devices-page__head">
        <div>
          <h3 id="devices-title">Devices</h3>
          <p>Pair desktop and TV clients, choose their libraries, or revoke access.</p>
        </div>
        <button className="btn btn--primary" onClick={togglePairing}>
          {pairing ? 'Cancel pairing' : 'Pair device'}
        </button>
      </div>

      {pairing && (
        <div className="pair-device" aria-label="Pair device">
          <label className="field-label" htmlFor="pair-code">
            Pairing code
          </label>
          <input
            id="pair-code"
            className="edit pair-device__code"
            value={pairCode}
            placeholder="ABC234"
            autoComplete="off"
            spellCheck={false}
            maxLength={6}
            onChange={(event) => {
              setPairCode(
                [...event.target.value.toUpperCase()]
                  .filter((character) => PAIR_CODE_ALPHABET.includes(character))
                  .join('')
                  .slice(0, 6),
              )
              mutations.approve.reset()
              setApproved(false)
            }}
          />
          <fieldset className="pair-device__libraries">
            <legend>Library access</legend>
            {libraries.length === 0 && <span>No libraries are registered.</span>}
            {libraries.map((library) => (
              <label className="check-row" key={library.id}>
                <input
                  type="checkbox"
                  checked={selectedIds.has(library.id)}
                  onChange={() => toggleLibrary(library.id)}
                  disabled={library.status !== 'available'}
                />
                {library.name}
                {library.status !== 'available' && ' (unavailable)'}
              </label>
            ))}
          </fieldset>
          {mutations.approve.error && (
            <div className="modal__error" role="alert">
              {mutations.approve.error.message}
            </div>
          )}
          {approved && (
            <div className="pair-device__success" role="status">
              Pairing approved. Waiting for the device to collect its token.
            </div>
          )}
          <button
            className="btn btn--primary pair-device__approve"
            onClick={submitPairing}
            disabled={
              pairCode.length !== 6 ||
              selectedAvailableIds.length === 0 ||
              mutations.approve.isPending
            }
          >
            {mutations.approve.isPending ? 'Approving…' : 'Approve device'}
          </button>
        </div>
      )}

      <div className="device-list" aria-live="polite">
        {devices.isLoading && <div className="inspector__empty">Loading devices…</div>}
        {devices.error && (
          <div className="modal__error" role="alert">
            {devices.error.message}
          </div>
        )}
        {devices.data?.length === 0 && (
          <div className="inspector__empty">No paired devices yet.</div>
        )}
        {devices.data?.map((device) => (
          <DeviceRow
            key={device.id}
            device={device}
            libraryNames={libraryNames}
            revoking={mutations.revoke.isPending && mutations.revoke.variables === device.id}
            onRevoke={() => mutations.revoke.mutate(device.id)}
          />
        ))}
      </div>
    </section>
  )
}

/** One paired-device audit row with its immutable library grant. */
function DeviceRow({
  device,
  libraryNames,
  revoking,
  onRevoke,
}: {
  device: DeviceRead
  libraryNames: Map<string, string>
  revoking: boolean
  onRevoke: () => void
}) {
  const revoked = device.revoked_at !== null
  const scopes = device.library_ids
    .map((id) => libraryNames.get(id) ?? 'Removed library')
    .join(', ')
  return (
    <article className={`device-row${revoked ? ' device-row--revoked' : ''}`}>
      <div className="device-row__main">
        <div className="device-row__name">
          {device.name}
          {revoked && <span className="badge badge--warn">revoked</span>}
        </div>
        <div className="device-row__libraries">{scopes}</div>
        <div className="device-row__dates">
          Created {formatDateTime(device.created_at)} · Last used{' '}
          {device.last_used_at ? formatDateTime(device.last_used_at) : 'never'}
        </div>
      </div>
      <button
        className="btn btn--danger btn--compact"
        onClick={onRevoke}
        disabled={revoked || revoking}
        aria-label={`Revoke ${device.name}`}
      >
        {revoking ? 'Revoking…' : 'Revoke'}
      </button>
    </article>
  )
}

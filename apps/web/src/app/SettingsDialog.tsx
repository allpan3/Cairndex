import { useMemo, useState } from 'react'

import type { DeviceRead, LibraryRead } from '../api/client'
import { useDeviceMutations, useDevices } from '../api/hooks'
import { formatDateTime } from '../lib/format'

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
          <DevicesPage libraries={libraries} libraryId={libraryId} startPairing={startPairing} />
        </div>
      </div>
    </div>
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

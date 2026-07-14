import { useMemo, useState } from 'react'

import type { DeviceRead, LibraryRead } from '../api/client'
import { useDeviceMutations, useDevices } from '../api/hooks'

/** Owner settings shell; Devices is the first global settings page. */
export function SettingsDialog({
  libraries,
  libraryId,
  onClose,
}: {
  libraries: LibraryRead[]
  libraryId: string | null
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
          <DevicesPage libraries={libraries} libraryId={libraryId} />
        </div>
      </div>
    </div>
  )
}

/** Pair, audit, and revoke native-client device credentials. */
function DevicesPage({
  libraries,
  libraryId,
}: {
  libraries: LibraryRead[]
  libraryId: string | null
}) {
  const devices = useDevices()
  const mutations = useDeviceMutations()
  const [pairing, setPairing] = useState(false)
  const [pairCode, setPairCode] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(libraryId ? [libraryId] : []),
  )
  const [approved, setApproved] = useState(false)
  const libraryNames = useMemo(
    () => new Map(libraries.map((library) => [library.id, library.name])),
    [libraries],
  )

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
      { pairCode, libraryIds: [...selectedIds] },
      { onSuccess: () => setApproved(true) },
    )
  }

  return (
    <section className="devices-page" aria-labelledby="devices-title">
      <div className="devices-page__head">
        <div>
          <h3 id="devices-title">Devices</h3>
          <p>Pair desktop and TV clients, choose their libraries, or revoke access.</p>
        </div>
        <button
          className="btn btn--primary"
          onClick={() => {
            setPairing(!pairing)
            setApproved(false)
          }}
        >
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
              setPairCode(event.target.value.replace(/\s/g, '').toUpperCase().slice(0, 6))
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
                />
                {library.name}
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
              pairCode.length !== 6 || selectedIds.size === 0 || mutations.approve.isPending
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
          Created {formatDate(device.created_at)} · Last used{' '}
          {device.last_used_at ? formatDate(device.last_used_at) : 'never'}
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

/** Compact local date used in device audit metadata. */
function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  )
}

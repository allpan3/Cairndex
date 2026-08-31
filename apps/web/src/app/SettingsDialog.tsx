import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  fetchHealth,
  pollDevicePairing,
  startDevicePairing,
  type DeviceRead,
  type LibraryRead,
} from '../api/client'
import { useDeviceMutations, useDevices } from '../api/hooks'
import { formatDateTime } from '../lib/format'
import { useDisplayPrefs } from '../state/displayPrefs'
import {
  DEFAULT_EXPORT_PREFS,
  MAX_WATERMARK_TEXT_LENGTH,
  useExportPrefs,
} from '../state/exportPrefs'
import { importWatermarkImage, WatermarkImageError, WATERMARK_FILE_ACCEPT } from './watermarkImage'
import {
  clearHostDeviceToken,
  getHostLabels,
  getHostPlatform,
  hasHostDeviceToken,
  hostOperationErrorMessage,
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
  const [page, setPage] = useState<'devices' | 'libraries' | 'appearance' | 'exports' | 'about'>(
    'devices',
  )
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
            <button
              className={`settings-nav__item${page === 'devices' ? ' settings-nav__item--active' : ''}`}
              onClick={() => setPage('devices')}
            >
              Devices
            </button>
            {desktop && (
              <button
                className={`settings-nav__item${page === 'libraries' ? ' settings-nav__item--active' : ''}`}
                onClick={() => setPage('libraries')}
              >
                Libraries
              </button>
            )}
            <button
              className={`settings-nav__item${page === 'exports' ? ' settings-nav__item--active' : ''}`}
              onClick={() => setPage('exports')}
            >
              Exports
            </button>
            <button
              className={`settings-nav__item${page === 'appearance' ? ' settings-nav__item--active' : ''}`}
              onClick={() => setPage('appearance')}
            >
              Appearance
            </button>
            <button
              className={`settings-nav__item${page === 'about' ? ' settings-nav__item--active' : ''}`}
              onClick={() => setPage('about')}
            >
              About
            </button>
          </nav>
          {page === 'about' ? (
            <AboutPage />
          ) : page === 'appearance' ? (
            <AppearancePage />
          ) : desktop && page === 'libraries' ? (
            <LibraryMappingsPage libraries={libraries} />
          ) : page === 'exports' ? (
            <ExportsPage desktop={desktop} />
          ) : desktop ? (
            <PairThisDevice startPairing={startPairing} />
          ) : (
            <DevicesPage libraries={libraries} libraryId={libraryId} startPairing={startPairing} />
          )}
        </div>
      </div>
    </div>
  )
}

/** Release identity for support and stale-install diagnosis. */
function AboutPage() {
  const health = useQuery({
    queryKey: ['health'],
    queryFn: ({ signal }) => fetchHealth(signal),
    staleTime: Infinity,
  })
  return (
    <section className="devices-page" aria-labelledby="about-title">
      <div className="devices-page__head">
        <div>
          <h3 id="about-title">About Cairndex</h3>
          <p>Build information for release verification and support.</p>
        </div>
      </div>
      {health.isLoading && <div className="inspector__empty">Loading build information…</div>}
      {health.error && (
        <div className="modal__error" role="alert">
          {health.error.message}
        </div>
      )}
      {health.data && (
        <dl className="about-build">
          <div>
            <dt>Version</dt>
            <dd>{health.data.version}</dd>
          </div>
          <div>
            <dt>Build commit</dt>
            <dd>{health.data.build_commit ?? 'Not recorded (development build)'}</dd>
          </div>
        </dl>
      )}
    </section>
  )
}

/**
 * Everything about the copies Cairndex writes outside the library.
 *
 * Two answers with different reach, which is why they share a page but not a
 * gate. **Where** exports land is desktop-only, because a browser can only ever
 * download. **What is stamped on them** applies wherever an export can be
 * started, so the page itself is no longer behind the desktop check it was
 * introduced under (2026-07-27).
 */
function ExportsPage({ desktop }: { desktop: boolean }) {
  return (
    <section className="devices-page" aria-labelledby="exports-title">
      <div className="devices-page__head">
        <div>
          <h3 id="exports-title">Exports</h3>
          <p>
            Snapshots, GIFs, and contact sheets. Nothing here changes your library — these are
            copies written outside it.
          </p>
        </div>
      </div>
      {desktop && <ExportFolderSetting />}
      <WatermarkSetting />
    </section>
  )
}

/** Where snapshots and exports land (owner request, 2026-07-27). Unset means
 * the native save dialog asks every time; choosing a folder makes saves land
 * there silently, keep-both on name collisions. The path is stored by the shell
 * and only ever enters it from the OS folder picker. */
function ExportFolderSetting() {
  const platform = getHostPlatform()
  const [dir, setDir] = useState<string | null>(null)
  useEffect(() => {
    void platform.getExportDir?.().then(setDir)
    // The platform singleton never changes identity within a session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <div className="settings-toggle">
      <span>
        <strong>{dir ?? 'Ask every time'}</strong>
        <span className="settings-toggle__hint">
          {dir
            ? 'Exports are saved straight here. A name already in use keeps both, never replacing the earlier file.'
            : 'Every export opens the save dialog so you can choose where it goes.'}
        </span>
      </span>
      <span className="settings-actions">
        <button
          className="btn"
          onClick={() => {
            void platform.pickExportDir?.().then((picked) => {
              if (picked !== null) setDir(picked)
            })
          }}
        >
          Choose Folder…
        </button>
        {dir !== null && (
          <button
            className="btn"
            onClick={() => {
              void platform.clearExportDir?.().then(() => setDir(null))
            }}
          >
            Ask Every Time
          </button>
        )}
      </span>
    </div>
  )
}

/**
 * The mark stamped on every export, and what it says.
 *
 * Off by default: these are the owner's own files, and a watermark is branding
 * rather than a courtesy. Turning it on replaces the fixed block contact sheets
 * used to carry, so the same mark now appears on all three export kinds instead
 * of one of them wearing a hardcoded one.
 *
 * The text field appears only once the mark is on, rather than sitting disabled
 * — there is nothing to say about the wording of a mark that is not applied.
 */
function WatermarkSetting() {
  const [prefs, setPrefs] = useExportPrefs()
  return (
    <>
      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={prefs.watermarkEnabled}
          onChange={(event) => setPrefs({ watermarkEnabled: event.target.checked })}
        />
        <span>
          <strong>Watermark exports</strong>
          <span className="settings-toggle__hint">
            Stamps snapshots and GIFs in the bottom-right corner, and contact sheets in their
            header. Only exported copies are marked — never the files in your library.
          </span>
        </span>
      </label>
      {prefs.watermarkEnabled && (
        <div className="settings-field">
          <span className="field-label" id="watermark-kind-label">
            Mark
          </span>
          <div className="settings-choice" role="radiogroup" aria-labelledby="watermark-kind-label">
            {(['text', 'image'] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                role="radio"
                aria-checked={prefs.watermarkKind === kind}
                className={`settings-choice__item${
                  prefs.watermarkKind === kind ? ' settings-choice__item--active' : ''
                }`}
                onClick={() => setPrefs({ watermarkKind: kind })}
              >
                {kind === 'text' ? 'Text' : 'Image'}
              </button>
            ))}
          </div>
          {prefs.watermarkKind === 'text' ? (
            <>
              <label className="field-label" htmlFor="watermark-text">
                Watermark text
              </label>
              <input
                id="watermark-text"
                className="edit"
                value={prefs.watermarkText}
                maxLength={MAX_WATERMARK_TEXT_LENGTH}
                spellCheck={false}
                placeholder={DEFAULT_EXPORT_PREFS.watermarkText}
                onChange={(event) => setPrefs({ watermarkText: event.target.value })}
              />
              <span className="settings-toggle__hint">
                Left empty, nothing is stamped. The mark scales with the export, so it reads the
                same on a small GIF as on a full-resolution snapshot.
              </span>
            </>
          ) : (
            <WatermarkImageField />
          )}
        </div>
      )}
    </>
  )
}

/**
 * Choosing the picture used as the mark.
 *
 * The file is inlined rather than referenced: a browser hands out no usable
 * path, and a copy under the data dir would turn a machine-local preference
 * into server state. It is bounded and normalized on the way in
 * (`watermarkImage.ts`), which is what makes storing it locally safe.
 */
function WatermarkImageField() {
  const [prefs, setPrefs] = useExportPrefs()
  const input = useRef<HTMLInputElement | null>(null)
  const [error, setError] = useState<string | null>(null)

  const choose = async (file: File | undefined) => {
    if (!file) return
    setError(null)
    try {
      const imported = await importWatermarkImage(file)
      setPrefs({ watermarkImage: imported.dataUrl, watermarkImageName: imported.name })
    } catch (caught) {
      setError(
        caught instanceof WatermarkImageError
          ? caught.message
          : 'That image could not be used as a watermark.',
      )
    }
  }

  return (
    <>
      <span className="field-label">Watermark image</span>
      {prefs.watermarkImage && (
        <div className="watermark-preview">
          {/* On a checkerboard, so a transparent logo does not look like it has
              a background it does not have. */}
          <span className="watermark-preview__plate">
            <img src={prefs.watermarkImage} alt="Watermark preview" />
          </span>
          <span className="watermark-preview__name">{prefs.watermarkImageName ?? 'Chosen'}</span>
        </div>
      )}
      <input
        ref={input}
        type="file"
        className="visually-hidden"
        accept={WATERMARK_FILE_ACCEPT}
        onChange={(event) => {
          void choose(event.target.files?.[0])
          // Cleared so re-picking the same file fires a change event again.
          event.target.value = ''
        }}
      />
      <span className="settings-actions settings-actions--start">
        <button className="btn btn--compact" onClick={() => input.current?.click()}>
          {prefs.watermarkImage ? 'Change Image…' : 'Choose Image…'}
        </button>
        {prefs.watermarkImage && (
          <button
            className="btn btn--compact"
            onClick={() => setPrefs({ watermarkImage: null, watermarkImageName: null })}
          >
            Remove
          </button>
        )}
      </span>
      {error !== null && (
        <div className="modal__error" role="alert">
          {error}
        </div>
      )}
      <span className="settings-toggle__hint">
        PNG, JPEG, WebP, or GIF. A transparent PNG works best. The image is scaled to the export, so
        one logo suits every size; with none chosen, nothing is stamped.
      </span>
    </>
  )
}

/** Maps server libraries to manifest-verified folders visible to this desktop. */
function LibraryMappingsPage({ libraries }: { libraries: LibraryRead[] }) {
  const { clearLibraryMapping, getLibraryMapping, locateLibrary } = getHostPlatform()
  const labels = getHostLabels()
  const queryClient = useQueryClient()
  // One cache entry per library, shared with the workspace's mapped-state
  // query, so locate/clear results flow to every host-action surface.
  const mappingQueries = useQueries({
    queries: libraries.map((library) => ({
      queryKey: ['library-mapping', library.id],
      queryFn: () => getLibraryMapping(library.id),
    })),
  })
  const loading = mappingQueries.some((query) => query.isPending)
  const loadError = mappingQueries.find((query) => query.error)?.error
  const [busyId, setBusyId] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  // Shares the busy/error lifecycle between the locate and clear actions
  const runMappingAction = async (libraryId: string, action: () => Promise<void>) => {
    setBusyId(libraryId)
    setErrors((previous) => ({ ...previous, [libraryId]: '' }))
    try {
      await action()
    } catch (error) {
      setErrors((previous) => ({ ...previous, [libraryId]: hostOperationErrorMessage(error) }))
    } finally {
      setBusyId(null)
    }
  }

  const locate = (library: LibraryRead) =>
    runMappingAction(library.id, async () => {
      const localRoot = await locateLibrary(library.id, library.library_uuid)
      if (localRoot === null) return
      queryClient.setQueryData(['library-mapping', library.id], localRoot)
    })

  const clear = (library: LibraryRead) =>
    runMappingAction(library.id, async () => {
      await clearLibraryMapping(library.id)
      queryClient.setQueryData(['library-mapping', library.id], null)
    })

  return (
    <section className="devices-page" aria-labelledby="libraries-title">
      <div className="devices-page__head">
        <div>
          <h3 id="libraries-title">Libraries</h3>
          <p>Locate each server library at its local or mounted path on this computer.</p>
        </div>
      </div>
      {loadError != null && (
        <div className="modal__error" role="alert">
          {hostOperationErrorMessage(loadError)}
        </div>
      )}
      {loading && <div className="inspector__empty">Loading library mappings…</div>}
      {!loading && libraries.length === 0 && (
        <div className="inspector__empty">No server libraries are registered.</div>
      )}
      {!loading && (
        <div className="library-mapping-list">
          {libraries.map((library, index) => {
            const localRoot = mappingQueries[index]?.data ?? null
            const busy = busyId === library.id
            return (
              <article className="library-mapping" key={library.id}>
                <div className="library-mapping__main">
                  <div className="library-mapping__name">{library.name}</div>
                  <div className="library-mapping__path">
                    {localRoot ?? 'Not located on this computer'}
                  </div>
                  {errors[library.id] && (
                    <div className="modal__error" role="alert">
                      {errors[library.id]}
                    </div>
                  )}
                </div>
                <div className="library-mapping__actions">
                  {localRoot && (
                    <button
                      className="btn btn--compact"
                      disabled={busy}
                      onClick={() => void clear(library)}
                    >
                      Remove
                    </button>
                  )}
                  <button
                    className="btn btn--primary btn--compact"
                    disabled={busy}
                    onClick={() => void locate(library)}
                  >
                    {busy ? 'Locating…' : labels.locateLibrary}
                  </button>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </section>
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

/**
 * Display preferences for this client (plan 4 follow-up).
 *
 * Local to the machine, not the library: it is how the owner likes to *look* at
 * their files, so it travels with the app rather than the metadata. Hiding
 * extensions changes the label only — never a path, a search match, or what a
 * rename operates on.
 */
function AppearancePage() {
  const [prefs, setPrefs] = useDisplayPrefs()

  return (
    <section className="devices-page" aria-labelledby="appearance-title">
      <div className="devices-page__head">
        <div>
          <h3 id="appearance-title">Appearance</h3>
          <p>How this computer displays your library. Nothing here changes your files.</p>
        </div>
      </div>
      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={prefs.hideFileExtensions}
          onChange={(event) => setPrefs({ hideFileExtensions: event.target.checked })}
        />
        <span>
          <strong>Hide file extensions</strong>
          <span className="settings-toggle__hint">
            Show “Holiday” instead of “Holiday.mkv” in the File Browser. Renaming still shows the
            full name, so an extension can never be lost by accident.
          </span>
        </span>
      </label>
    </section>
  )
}

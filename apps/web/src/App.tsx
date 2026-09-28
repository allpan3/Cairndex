import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { ConnectionControls } from './desktop/ConnectionControls'

import { setActiveLibraryId } from './api/client'
import {
  resetLibraryContentQueries,
  useLibraries,
  useLibraryAuth,
  useLibraryLock,
  useLibraryOwnership,
  useLibraryServing,
  useStartTakeover,
} from './api/hooks'
import { LibraryAccessNotice } from './app/LibraryAccessNotice'
import { LibraryManager } from './app/LibraryManager'
import { LibraryOwnershipNotice } from './app/LibraryOwnershipNotice'
import { LockScreen } from './app/LockScreen'
import { ReplicaWorkspace } from './app/ReplicaWorkspace'
import { SettingsDialog } from './app/SettingsDialog'
import { Sidebar } from './app/Sidebar'
import {
  connectToServer,
  getActiveConnection,
  getConnections,
  getPendingSelectionVersion,
  libraryStorageKey,
  subscribeConnections,
  takePendingLibrarySelection,
} from './desktop/connections'
import { useDeepLink } from './desktop/useDeepLink'
import { useDesktopMenu, useDesktopMenuAvailability } from './desktop/useDesktopMenu'
import {
  getHostPlatform,
  hasHostDeviceAccess,
  hasHostDeviceToken,
  type DeepLinkTarget,
} from './platform'
import { usePersistentState } from './state/usePersistentState'

/**
 * App shell: resolve the active library (one per tab, ADR-0008) before any
 * content query runs. While there are no libraries the manager is shown so the
 * owner can create or register one. Switching libraries drops the previous
 * library's content queries before the library-keyed workspace remounts, so
 * neither server state nor local UI state can bleed across libraries.
 */
export default function App() {
  if (getHostPlatform().kind === 'desktop') return <LibraryApp />
  return (
    <div className="connection-shell">
      <ConnectionControls />
      <div className="connection-content">
        <LibraryApp />
      </div>
    </div>
  )
}

// Resolves the intended library without silently substituting a different destination
function LibraryApp() {
  const queryClient = useQueryClient()
  const librariesQuery = useLibraries({ pollWhileUnavailable: true })
  // Keyed per connection: library ids are per-server and not globally unique,
  // so one shared key could carry a NAS id into the local server (plan 3 §7.1).
  // In the browser there is one connection forever and the key is the original.
  const activeConnectionId = useSyncExternalStore(
    subscribeConnections,
    () => getConnections().activeConnectionId,
  )
  const [chosenId, setChosenId] = usePersistentState<string | null>(
    libraryStorageKey(activeConnectionId),
    null,
  )
  const [linkedUuid, setLinkedUuid] = useState(() =>
    new URLSearchParams(window.location.search).get('library_uuid'),
  )
  const [managing, setManaging] = useState(false)
  // Following a lease redirect ("Connect to <holder>"): in flight, and why it
  // failed. Both only matter on the ownership notice below.
  const [connectRedirect, setConnectRedirect] = useState<{
    pending: boolean
    error: string | null
  }>({ pending: false, error: null })
  const [settingsPage, setSettingsPage] = useState<'devices' | 'pair' | 'shortcuts' | null>(null)
  const [, setDeepLink] = useState<PendingDeepLink | null>(null)

  const libraries = useMemo(() => librariesQuery.data ?? [], [librariesQuery.data])
  const defaultLibrary = libraries.find((library) => library.status === 'available') ?? libraries[0]
  const libraryId = linkedUuid
    ? (libraries.find((entry) => entry.library_uuid === linkedUuid)?.id ?? null)
    : (chosenId ?? defaultLibrary?.id ?? null)
  const library = libraries.find((candidate) => candidate.id === libraryId)
  // Persist an initial default so a later registry reorder cannot change the intended library
  useEffect(() => {
    if (!linkedUuid && !chosenId && defaultLibrary) setChosenId(defaultLibrary.id)
  }, [chosenId, defaultLibrary, setChosenId, linkedUuid])

  const changeLibrary = useCallback(
    (nextId: string) => {
      if (linkedUuid) {
        setLinkedUuid(null)
        const url = new URL(window.location.href)
        url.searchParams.delete('library_uuid')
        window.history.replaceState(null, '', url)
      }
      if (nextId === libraryId) {
        setChosenId(nextId)
        return
      }
      // Set the request scope before active observers are removed so no old
      // query can restart against the library being left behind
      setActiveLibraryId(nextId)
      resetLibraryContentQueries(queryClient)
      setChosenId(nextId)
    },
    [libraryId, queryClient, setChosenId, linkedUuid],
  )

  // Resolve browser ownership redirects within the destination server before content admission
  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (active && linkedUuid && libraryId) changeLibrary(libraryId)
    })
    return () => {
      active = false
    }
  }, [linkedUuid, libraryId, changeLibrary])

  // A library was deregistered. Content query keys are not library-scoped — the
  // active library is module-global and the cache is cleared on every switch —
  // so the removed library's cached bundles, collections, and counts have to go
  // with it, or whichever library is shown next inherits them. Clearing the
  // stored choice lets the list's own fallback pick what to show, including the
  // empty shell when that was the last library.
  const forgetRemovedLibrary = useCallback(
    (removedId: string) => {
      if (removedId !== libraryId) return
      setActiveLibraryId(null)
      resetLibraryContentQueries(queryClient)
      setChosenId(null)
    },
    [libraryId, queryClient, setChosenId],
  )

  // "Manage Libraries…" is handled *here* as well as in DesktopBootstrap. The
  // two cover different states and both are real: the bootstrap's listener
  // tears down once the workspace mounts (`if (ready) return`), so handling it
  // only there left the item dead in the running app — which is where a user
  // spends all their time. The menu item is enabled in both states, so both
  // must listen. What each does differs, though: here the item opens the
  // Libraries dialog, which is the one surface for adding, opening, and
  // removing. The bootstrap cannot show that dialog — it lists a server's
  // libraries and there is no server yet — so it picks a folder directly.
  useDesktopMenu((action) => {
    // The desktop shell has no browser chrome, so ⌘R is only a reload if the
    // menu makes it one — without this item the key did nothing at all.
    if (action === 'reload') globalThis.location.reload()
    else if (action === 'settings') setSettingsPage('devices')
    else if (action === 'keyboard-shortcuts') setSettingsPage('shortcuts')
    else if (action === 'pair-device') setSettingsPage('pair')
    else if (action === 'manage-libraries') setManaging(true)
  })

  // Native opens queue selection only after activation succeeds; the version also handles same-server opens
  const pendingVersion = useSyncExternalStore(subscribeConnections, getPendingSelectionVersion)
  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (!active) return
      const pending = takePendingLibrarySelection(activeConnectionId)
      if (pending) changeLibrary(pending)
    })
    return () => {
      active = false
    }
  }, [activeConnectionId, pendingVersion, changeLibrary])

  // A cairndex:// link may name a library other than the active one, so the
  // switch happens here while the target itself is handed to the workspace. The
  // workspace is keyed on libraryId, so it remounts on a switch and then consumes
  // the target — which is why the target lives in App state rather than in the
  // workspace's own.
  //
  // Delivery is gated on the libraries query having *succeeded*, not merely
  // settled. A cold-start link is drained within milliseconds of mount, so
  // classifying it against an empty list would report every `?library=` link as
  // "not on this server" — and on an errored query that message would be doubly
  // wrong, since the app is already showing a connection failure. Classification
  // therefore only ever runs against a list that actually loaded. The shell parks
  // links until we drain them, so waiting loses nothing.
  useDeepLink(
    useCallback(
      (target) => {
        const named = target.libraryId ?? null
        const known = named === null || libraries.some((library) => library.id === named)
        if (known && named !== null) changeLibrary(named)
        // An unknown library id is reported rather than silently opening the
        // target in whatever library happens to be active — that could show a
        // different bundle than the link meant.
        setDeepLink({ ...target, unknownLibrary: known ? null : named })
      },
      [libraries, changeLibrary],
    ),
    librariesQuery.isSuccess,
  )

  // Set the module-global active library during render so content queries (which
  // run after commit) target the right library. An unavailable row is registry
  // information, not a mountable content scope
  const mountableLibraryId = library?.status === 'available' ? libraryId : null
  setActiveLibraryId(mountableLibraryId)

  // Per-library lock (ADR-0010): resolve lock state before mounting the
  // workspace, so a protected+locked library shows its passphrase screen and
  // never fires content queries while locked.
  const auth = useLibraryAuth(mountableLibraryId)
  const lock = useLibraryLock(mountableLibraryId)
  // Ownership is checked at the mount gate, not by reacting to 409s from
  // content queries: a lease refusal would otherwise arrive once per query as a
  // scatter of identical errors instead of one explainable state (ADR-0018).
  const ownership = useLibraryOwnership(mountableLibraryId)
  const takeover = useStartTakeover(mountableLibraryId)
  const serving = useLibraryServing(mountableLibraryId)
  const locked = auth.data?.protected === true && auth.data.unlocked === false
  const desktop = getHostPlatform().kind === 'desktop'
  const deviceHasAccess = mountableLibraryId ? hasHostDeviceAccess(mountableLibraryId) : false
  useDesktopMenuAvailability(mountableLibraryId !== null && auth.isSuccess && !locked)

  // The one surface for adding, opening, and removing libraries. Rendered in
  // every state the menu item is enabled in — including the ones that replace
  // the workspace, which are exactly the states (a lease refusal, a locked
  // library) where switching to another library is what a user wants.
  const libraryDialog = managing && (
    <LibraryManager
      onClose={() => setManaging(false)}
      onSelect={changeLibrary}
      onRemoved={forgetRemovedLibrary}
    />
  )

  if (librariesQuery.isLoading) {
    return (
      <>
        <div className="app-loading">Loading…</div>
        {libraryDialog}
      </>
    )
  }

  if (librariesQuery.isError || ((libraryId || linkedUuid) && !library)) {
    return (
      <>
        <LibraryAccessNotice
          libraries={libraries}
          libraryId={libraryId ?? ''}
          onChangeLibrary={changeLibrary}
          title={librariesQuery.isError ? 'Server unavailable' : 'Selected library is missing'}
          message={
            librariesQuery.isError
              ? 'The library list could not be reached. Check the server or network, then retry or choose another server. Your selected library is remembered.'
              : 'This server no longer lists the selected library. Restore its registration, retry, or choose another library.'
          }
        >
          <button
            className="lockscreen__submit"
            disabled={librariesQuery.isFetching}
            onClick={() => void librariesQuery.refetch()}
          >
            {librariesQuery.isFetching ? 'Checking…' : 'Retry'}
          </button>
          <button className="btn" onClick={() => setManaging(true)}>
            Manage Libraries
          </button>
        </LibraryAccessNotice>
        {libraryDialog}
      </>
    )
  }

  if (!libraryId) {
    // No library yet: show the empty app shell (not a forced dialog) so the
    // owner can add one from the sidebar "+" when ready. Adding one re-renders
    // into the workspace once the list refreshes.
    return (
      <>
        <NoLibraryView
          onManage={() => setManaging(true)}
          onSettings={() => setSettingsPage('devices')}
        />
        {libraryDialog}
        {settingsPage && (
          <SettingsDialog
            key={settingsPage}
            libraries={libraries}
            libraryId={null}
            startPairing={settingsPage === 'pair'}
            showShortcuts={settingsPage === 'shortcuts'}
            onClose={() => setSettingsPage(null)}
          />
        )}
      </>
    )
  }

  const settingsDialog = settingsPage && (
    <SettingsDialog
      key={settingsPage}
      libraries={libraries}
      libraryId={libraryId}
      startPairing={settingsPage === 'pair'}
      showShortcuts={settingsPage === 'shortcuts'}
      onClose={() => setSettingsPage(null)}
    />
  )

  // Do not ask a row that already failed the registry probe for ownership,
  // authentication, or content. Besides producing redundant I/O, doing so used
  // to mount the browser and replace its spinner with the server's raw id-based
  // availability error. A returning volume is picked up by Retry or the bounded
  // foreground poll in useLibraries.
  if (library?.status === 'unavailable') {
    return (
      <>
        <LibraryAccessNotice
          libraries={libraries}
          libraryId={library.id}
          onChangeLibrary={changeLibrary}
          title="Library unavailable"
          message={`${library.name} cannot be reached at its registered location. Reconnect its drive or network share, or use Manage Libraries if the folder moved.`}
        >
          <button
            className="lockscreen__submit"
            onClick={() => void librariesQuery.refetch()}
            disabled={librariesQuery.isFetching}
          >
            {librariesQuery.isFetching ? 'Checking…' : 'Retry'}
          </button>
          <button className="btn" onClick={() => setManaging(true)}>
            Manage Libraries
          </button>
          {librariesQuery.isError && (
            <span className="lockscreen__error">Could not refresh the library list.</span>
          )}
        </LibraryAccessNotice>
        {settingsDialog}
        {libraryDialog}
      </>
    )
  }

  // Authentication also protects administration while serving is released.
  if (auth.isPending) {
    return (
      <>
        <div className="app-loading">Checking library access…</div>
        {settingsDialog}
        {libraryDialog}
      </>
    )
  }

  if (auth.isError) {
    return (
      <>
        <LibraryAccessNotice
          libraries={libraries}
          libraryId={libraryId}
          onChangeLibrary={changeLibrary}
          title="Could not verify library access"
          message={
            desktop && deviceHasAccess
              ? 'The stored device credential may be invalid or revoked. Forget it in Settings, then pair again.'
              : auth.error.message
          }
        >
          <button className="lockscreen__submit" onClick={() => void auth.refetch()}>
            Try again
          </button>
          <button className="btn" onClick={() => setSettingsPage('devices')}>
            Open Settings
          </button>
        </LibraryAccessNotice>
        {settingsDialog}
        {libraryDialog}
      </>
    )
  }

  if (locked) {
    if (desktop && getActiveConnection()?.kind !== 'local') {
      return (
        <>
          <LibraryAccessNotice
            libraries={libraries}
            libraryId={libraryId}
            onChangeLibrary={changeLibrary}
            title={`${libraries.find((library) => library.id === libraryId)?.name ?? 'Library'} needs device access`}
            message={
              hasHostDeviceToken()
                ? 'This device is paired, but not for this protected library. Pair again and include it in the approved scope.'
                : 'Protected libraries use owner-approved device pairing in the desktop app.'
            }
          >
            <button className="lockscreen__submit" onClick={() => setSettingsPage('pair')}>
              {hasHostDeviceToken() ? 'Pair again' : 'Pair this device'}
            </button>
            <span className="lockscreen__hint">
              Passphrase unlock remains available in the same-origin web app.
            </span>
          </LibraryAccessNotice>
          {settingsDialog}
          {libraryDialog}
        </>
      )
    }
    return (
      <>
        <LockScreen
          key={libraryId}
          libraries={libraries}
          libraryId={libraryId}
          onChangeLibrary={changeLibrary}
          onUnlock={(passphrase) => lock.unlock.mutate(passphrase)}
          unlocking={lock.unlock.isPending}
          error={lock.unlock.error?.message ?? null}
        />
        {settingsDialog}
        {libraryDialog}
      </>
    )
  }

  // Release controls remain reachable after authentication without mounting content.
  if (libraryId && ownership.data?.mountable === false) {
    return (
      <>
        <LibraryOwnershipNotice
          ownership={ownership.data}
          libraries={libraries}
          libraryId={libraryId}
          onChangeLibrary={changeLibrary}
          onTakeOver={() => takeover.mutate()}
          onManage={() => setManaging(true)}
          onReopen={() => serving.mutate('reopen')}
          onRetryRelease={() => serving.mutate('release')}
          reopenPending={serving.isPending}
          reopenError={serving.error?.message ?? null}
          onConnectTo={(serverUrl) => {
            setConnectRedirect({ pending: true, error: null })
            void connectToServer(serverUrl, library?.library_uuid)
              // On success the whole scope remounts, so there is nothing to
              // clear here — only the failure has to land somewhere visible.
              .catch((error: unknown) =>
                setConnectRedirect({
                  pending: false,
                  error:
                    error instanceof Error ? error.message : 'Could not connect to that server.',
                }),
              )
          }}
          connectPending={connectRedirect.pending}
          connectError={connectRedirect.error}
          takeoverPending={takeover.isPending}
          takeoverError={
            takeover.error instanceof Error
              ? takeover.error.message
              : (ownership.data.takeover?.error_message ?? null)
          }
        />
        {settingsDialog}
        {libraryDialog}
      </>
    )
  }

  // Do not fan out content queries before the mount decision is known. On a
  // cold desktop start that race mounted Workspace, then cancelled its entire
  // query burst when the ownership result arrived; WebKit could leave the
  // browser sitting at "Loading library…" until another action caused a retry.
  // An errored or malformed ownership response still fails open below, as the
  // server's content-route gate remains authoritative.
  if (ownership.isPending) {
    return (
      <>
        <div className="app-loading">Checking library ownership…</div>
        {settingsDialog}
        {libraryDialog}
      </>
    )
  }

  if (ownership.isError) {
    return (
      <>
        <LibraryAccessNotice
          libraries={libraries}
          libraryId={libraryId}
          onChangeLibrary={changeLibrary}
          title="Could not check library ownership"
          message="The server could not confirm that it can serve this library. Check its connection and storage, then retry."
        >
          <button
            className="lockscreen__submit"
            onClick={() => void ownership.refetch()}
            disabled={ownership.isFetching}
          >
            {ownership.isFetching ? 'Checking…' : 'Retry'}
          </button>
          <button className="btn" onClick={() => setManaging(true)}>
            Manage Libraries
          </button>
        </LibraryAccessNotice>
        {settingsDialog}
        {libraryDialog}
      </>
    )
  }

  return (
    <>
      <ReplicaWorkspace
        key={libraryId}
        libraryId={libraryId}
        libraries={libraries}
        onChangeLibrary={changeLibrary}
        onManage={() => setManaging(true)}
        onSettings={() => setSettingsPage('devices')}
      />
      {libraryDialog}
      {settingsDialog}
    </>
  )
}

// Fails closed while preserving library switching and desktop recovery actions
/**
 * Empty app shell shown before any library exists. Renders the real sidebar
 * (so the "+" to add a library sits where it always does) with no content, and
 * an empty center pane — no content queries run without an active library.
 */
function NoLibraryView({ onManage, onSettings }: { onManage: () => void; onSettings: () => void }) {
  const noop = () => {}
  return (
    <div className="app">
      <Sidebar
        mode="collection"
        onMode={noop}
        libraries={[]}
        libraryId={null}
        onChangeLibrary={noop}
        onManageLibraries={onManage}
        onOpenSettings={onSettings}
        onUpdateLibrary={noop}
        onScanFiles={noop}
        onProbe={noop}
        onGenerateStoryboards={noop}
        onReviewGrouping={noop}
        selection={{ view: 'all', collectionId: null }}
        onSelect={noop}
        collections={[]}
        onDeleteCollection={noop}
        onCreateCollection={noop}
        onRenameCollection={noop}
        onReorderCollections={noop}
        smartCollections={[]}
        onNewSmartCollection={noop}
        onEditSmartCollection={noop}
        onDeleteSmartCollection={noop}
      />
      <div className="center">
        <div className="state">
          No library yet. Click the <strong>library</strong> icon at the top left to add one.
        </div>
      </div>
      <aside className="inspector" data-tauri-drag-region />
    </div>
  )
}

// A deep-link target awaiting the workspace, plus the library id the link named
// when this server has no such library (reported instead of silently ignored).
interface PendingDeepLink extends DeepLinkTarget {
  unknownLibrary: string | null
}

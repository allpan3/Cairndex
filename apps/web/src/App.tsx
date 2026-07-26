import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import type {
  BundleSort,
  CollectionRead,
  FileSelection,
  FileBrowserEntry,
  JobRead,
  LibraryRead,
  SmartCollectionRead,
  SortOrder,
} from './api/client'
import { markBundleOpened, setActiveLibraryId } from './api/client'
import {
  useBatchUpdate,
  useBrowse,
  useCollectionCounts,
  useCollections,
  useCleanupBundleOrder,
  useCleanupCollectionOrder,
  useCreateCollection,
  useDeleteBundles,
  useDeleteCollection,
  useReorderBundles,
  useReorderCollections,
  useDeploymentWriteMode,
  useFileOperations,
  invalidateAfterFileOperation,
  useLibraries,
  useLibraryAuth,
  useTrash,
  useLibraryOwnership,
  useStartTakeover,
  useLibraryLock,
  useProbe,
  resetLibraryContentQueries,
  useRenameCollection,
  useUpdateCollection,
  useScan,
  useStoryboards,
  useSmartCollectionMutations,
  useSmartCollections,
  useUpdateLibrary,
  useViewCounts,
} from './api/hooks'
import { AllTagsPage } from './app/AllTagsPage'
import { ContextMenu } from './app/ContextMenu'
import { type MenuEntry, useContextMenu } from './app/useContextMenu'
import { Browser } from './app/Browser'
import { BundleAlbum } from './app/BundleAlbum'
import { DeleteBundlesDialog } from './app/DeleteBundlesDialog'
import { FileInspector } from './app/FileInspector'
import { ImportProgress } from './app/ImportProgress'
import { FileBrowser } from './app/FileBrowser'
import { GroupingReview } from './app/GroupingReview'
import { buildDeepLinkUri, copyText } from './app/deepLinkUri'
import { hostFileMenuEntries } from './app/hostActions'
import { isMultiSelection, selectionTargets } from './app/selection'
import { LibraryManager } from './app/LibraryManager'
import { LockScreen } from './app/LockScreen'
import { type FilterDraft, emptyDraft } from './app/filterModel'
import {
  type AdHocFilters,
  type FacetContext,
  adHocFiltersToExpression,
  combineFilters,
  emptyAdHocFilters,
} from './app/adHocFilters'
import { Inspector } from './app/Inspector'
import {
  AddFilesToBundleDialog,
  AddToBundleDialog,
  CreateBundleDialog,
  CreateEmptyBundleDialog,
} from './app/ManualBundlingDialogs'
import { CleanupOrderDialog } from './app/CleanupOrderDialog'
import type { DragItem } from './app/dnd'
import { CollectionHeader } from './app/CollectionHeader'
import { CollectionInspector } from './app/CollectionInspector'
import { MultiBundleInspector } from './app/MultiBundleInspector'
import { RemoveCollectionDialog } from './app/RemoveCollectionDialog'
import { ConflictDialog } from './app/FileWriteDialogs'
import { Sidebar } from './app/Sidebar'
import { TrashView } from './app/TrashView'
import { SettingsDialog } from './app/SettingsDialog'
import { SmartCollectionEditor } from './app/SmartCollectionEditor'
import { Toolbar } from './app/Toolbar'
import { ZOOM_MAX, ZOOM_MIN } from './app/layout'
import { MediaViewer } from './app/viewer/MediaViewer'
import { type DropMappingState, useDesktopFileDrop } from './desktop/fileDrop'
import { useHostImports } from './desktop/useHostImports'
import {
  connectToServer,
  getConnections,
  getPendingSelectionVersion,
  libraryStorageKey,
  subscribeConnections,
  takePendingLibrarySelection,
} from './desktop/connections'
import { LibraryAccessNotice } from './app/LibraryAccessNotice'
import { LibraryOwnershipNotice } from './app/LibraryOwnershipNotice'
import { useDeepLink } from './desktop/useDeepLink'
import { useDesktopMenu, useDesktopMenuAvailability } from './desktop/useDesktopMenu'
import { useJobNotifications } from './desktop/useJobNotifications'
import {
  DEFAULT_PREFS,
  RECENT_SORTS,
  STANDARD_SORTS,
  SYSTEM_VIEWS,
  type AppMode,
  type BrowsePrefs,
  type PlayerPrefs,
  type Selection,
  type SortPref,
} from './app/types'
import { usePersistentState } from './state/usePersistentState'
import {
  getHostLabels,
  getHostPlatform,
  hasHostDeviceAccess,
  hasHostDeviceToken,
  hostOperationErrorMessage,
  reverseMapHostPaths,
  type DeepLinkTarget,
} from './platform'

interface EditorState {
  existing?: SmartCollectionRead | null
  initialDraft?: FilterDraft
}

/** `rootId` plus every collection nested beneath it (used to clear a stale
 * selection when a cascade removal deletes the collection currently in view). */
function collectionSubtreeIds(collections: CollectionRead[], rootId: string): Set<string> {
  const childrenOf = new Map<string, string[]>()
  for (const c of collections)
    if (c.parent_id) childrenOf.set(c.parent_id, [...(childrenOf.get(c.parent_id) ?? []), c.id])
  const ids = new Set<string>([rootId])
  const stack = [rootId]
  while (stack.length) {
    const id = stack.pop() as string
    for (const childId of childrenOf.get(id) ?? []) {
      ids.add(childId)
      stack.push(childId)
    }
  }
  return ids
}

function Resizer({
  side,
  width,
  setWidth,
  min,
  max,
}: {
  side: 'left' | 'right'
  width: number
  setWidth: (n: number) => void
  min: number
  max: number
}) {
  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    const onMove = (ev: MouseEvent) => {
      const delta = side === 'left' ? ev.clientX - startX : startX - ev.clientX
      setWidth(Math.max(min, Math.min(max, startW + delta)))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
  }
  return (
    <div
      className="resizer-bar"
      style={{ position: 'absolute', top: 0, bottom: 0, width: 7, [side]: width - 3 }}
      onMouseDown={onMouseDown}
      role="separator"
      aria-orientation="vertical"
    />
  )
}

/**
 * App shell: resolve the active library (one per tab, ADR-0008) before any
 * content query runs. While there are no libraries the manager is shown so the
 * owner can create or register one. Switching libraries drops the previous
 * library's content queries before the library-keyed workspace remounts, so
 * neither server state nor local UI state can bleed across libraries.
 */
export default function App() {
  const queryClient = useQueryClient()
  const librariesQuery = useLibraries()
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
  const [managing, setManaging] = useState(false)
  const [settingsPage, setSettingsPage] = useState<'devices' | 'pair' | null>(null)
  const [deepLink, setDeepLink] = useState<PendingDeepLink | null>(null)

  const libraries = useMemo(() => librariesQuery.data ?? [], [librariesQuery.data])
  const libraryId = useMemo(() => {
    if (chosenId && libraries.some((l) => l.id === chosenId)) return chosenId
    return libraries[0]?.id ?? null
  }, [libraries, chosenId])

  const changeLibrary = useCallback(
    (nextId: string) => {
      if (nextId === libraryId) return
      // Set the request scope before active observers are removed so no old
      // query can restart against the library being left behind
      setActiveLibraryId(nextId)
      resetLibraryContentQueries(queryClient)
      setChosenId(nextId)
    },
    [libraryId, queryClient, setChosenId],
  )

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
    else if (action === 'pair-device') setSettingsPage('pair')
    else if (action === 'manage-libraries') setManaging(true)
  })

  // Opening a folder queues its result before activating the connection,
  // because activation remounts this tree. Consumed here on mount rather than
  // read during render: taking it is a side effect, and the take is idempotent
  // (a second run finds nothing, and re-selecting the same library is a no-op),
  // so StrictMode's double-invoke is harmless.
  // Depends on the queue version as well as the connection, because re-opening
  // a folder on the *already active* connection changes no id and remounts
  // nothing — the case where the second open of a registered library silently
  // did nothing.
  const pendingVersion = useSyncExternalStore(subscribeConnections, getPendingSelectionVersion)
  useEffect(() => {
    const pending = takePendingLibrarySelection(activeConnectionId)
    if (pending) changeLibrary(pending)
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
  // run after commit) target the right library.
  if (libraryId) setActiveLibraryId(libraryId)

  // Per-library lock (ADR-0010): resolve lock state before mounting the
  // workspace, so a protected+locked library shows its passphrase screen and
  // never fires content queries while locked.
  const auth = useLibraryAuth(libraryId)
  const lock = useLibraryLock(libraryId)
  // Ownership is checked at the mount gate, not by reacting to 409s from
  // content queries: a lease refusal would otherwise arrive once per query as a
  // scatter of identical errors instead of one explainable state (ADR-0018).
  const ownership = useLibraryOwnership(libraryId)
  const takeover = useStartTakeover(libraryId)
  const locked = auth.data?.protected === true && auth.data.unlocked === false
  const desktop = getHostPlatform().kind === 'desktop'
  const deviceHasAccess = libraryId ? hasHostDeviceAccess(libraryId) : false
  useDesktopMenuAvailability(libraryId !== null && auth.isSuccess && !locked)

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
      onClose={() => setSettingsPage(null)}
    />
  )

  // Placed before the auth gate: a library this server may not serve cannot be
  // unlocked either, so the passphrase screen would be a dead end.
  // `=== false`, not `!mountable`: this screen only ever appears when the server
  // explicitly says the library is not servable here. An absent or malformed
  // field must fail *open* — the server's own mount gate is the enforcement, and
  // this UI is the explanation, so blocking on an unparsed response would hide a
  // working library behind an unexplained wall.
  if (libraryId && ownership.data?.mountable === false) {
    return (
      <>
        <LibraryOwnershipNotice
          ownership={ownership.data}
          libraries={libraries}
          libraryId={libraryId}
          onChangeLibrary={changeLibrary}
          onTakeOver={() => takeover.mutate()}
          onConnectTo={(serverUrl) => {
            void connectToServer(serverUrl)
          }}
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
    if (desktop) {
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

  return (
    <>
      <Workspace
        key={libraryId}
        libraries={libraries}
        libraryId={libraryId}
        deepLink={deepLink}
        onDeepLinkHandled={() => setDeepLink(null)}
        onChangeLibrary={changeLibrary}
        onManage={() => setManaging(true)}
        onSettings={() => setSettingsPage('devices')}
        canLock={auth.data?.protected === true && getHostPlatform().kind === 'web'}
        onLock={() => lock.lock.mutate()}
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

interface WorkspaceProps {
  libraries: LibraryRead[]
  libraryId: string
  deepLink: PendingDeepLink | null
  onDeepLinkHandled: () => void
  onChangeLibrary: (id: string) => void
  onManage: () => void
  onSettings: () => void
  canLock: boolean
  onLock: () => void
}

function Workspace({
  libraries,
  libraryId,
  deepLink,
  onDeepLinkHandled,
  onChangeLibrary,
  onManage,
  onSettings,
  canLock,
  onLock,
}: WorkspaceProps) {
  const [storedPrefs, setPrefs] = usePersistentState<BrowsePrefs>('cairndex.prefs', DEFAULT_PREFS, {
    debounceMs: 300,
  })
  // Merge in defaults so prefs persisted before newer fields existed
  // (sortScope/collectionSorts) don't read back as undefined.
  const prefs = useMemo(
    () => ({
      ...DEFAULT_PREFS,
      ...storedPrefs,
      player: { ...DEFAULT_PREFS.player, ...storedPrefs.player },
    }),
    [storedPrefs],
  )
  const setPlayerPrefs = useCallback(
    (updater: React.SetStateAction<PlayerPrefs>) => {
      setPrefs((previous) => {
        const previousPlayer = { ...DEFAULT_PREFS.player, ...previous.player }
        const player = typeof updater === 'function' ? updater(previousPlayer) : updater
        return { ...DEFAULT_PREFS, ...previous, player }
      })
    },
    [setPrefs],
  )
  const [sidebarW, setSidebarW] = usePersistentState('cairndex.sidebarW', 240)
  const [inspectorW, setInspectorW] = usePersistentState('cairndex.inspectorW', 300)
  const { sidebarVisible, inspectorVisible } = prefs

  const [selection, setSelection] = useState<Selection>({ view: 'all', collectionId: null })
  // Ad-hoc toolbar filters (Eagle-style). Local UI state only — not persisted to
  // localStorage or the URL in this milestone. Composes with the active Smart
  // Collection and the current view/collection/search.
  const [adHocFilters, setAdHocFilters] = useState<AdHocFilters>(emptyAdHocFilters)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [activeId, setActiveId] = useState<string | null>(null)
  // Anchors for Shift-range selection: the last plainly-clicked bundle / folder
  // card. Shift+click selects the inclusive range from the anchor to the click.
  const [bundleAnchor, setBundleAnchor] = useState<string | null>(null)
  const [collectionAnchor, setCollectionAnchor] = useState<string | null>(null)
  // What's currently being dragged (bundles or a collection), so folder cards and
  // sidebar rows can accept cross-surface drops (reparent / move into collection).
  const [dragItem, setDragItem] = useState<DragItem | null>(null)
  const [openBundleId, setOpenBundleId] = useState<string | null>(null)
  const [viewerTarget, setViewerTarget] = useState<{
    bundleId: string
    initialFileId?: string
  } | null>(null)
  const [search, setSearch] = useState('')
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [reviewingGrouping, setReviewingGrouping] = useState(false)
  const [reviewPlanId, setReviewPlanId] = useState<string | null>(null)
  const [removingCollections, setRemovingCollections] = useState<CollectionRead[] | null>(null)
  const [deletingBundles, setDeletingBundles] = useState<string[] | null>(null)
  // "Clean up by…" dialogs (rewrite the manual order). Collections offer Title
  // A–Z/Z–A; bundles reuse the toolbar sorts.
  const [cleaningCollections, setCleaningCollections] = useState(false)
  const [cleaningBundles, setCleaningBundles] = useState(false)

  // Manual bundling assistant dialogs. Each holds the selection to act on —
  // File-View/Unbundled files as relative paths (unlinked ones auto-linked at
  // apply) or backend file ids.
  const [addingToBundle, setAddingToBundle] = useState<FileSelection | null>(null)
  const [creatingBundle, setCreatingBundle] = useState<FileSelection | null>(null)
  const [creatingEmpty, setCreatingEmpty] = useState(false)
  const [addFilesBundleId, setAddFilesBundleId] = useState<string | null>(null)
  // Transient success banner after a manual bundling action.
  const [flash, setFlash] = useState<string | null>(null)
  // The Undo behind a completed file operation (ADR-0013 §3.1), when the toast
  // has one. Cleared with the message it belongs to, so an expired toast can
  // never leave a stale inverse behind a button.
  const [flashUndo, setFlashUndo] = useState<(() => void) | null>(null)
  useEffect(() => {
    if (flash === null) return
    // An offer to undo is worth reading twice; a plain confirmation is not.
    const t = setTimeout(
      () => {
        setFlash(null)
        setFlashUndo(null)
      },
      flashUndo ? 8000 : 4000,
    )
    return () => clearTimeout(t)
  }, [flash, flashUndo])

  // Show a message, optionally with the action that reverses what it reports.
  const showFlash = useCallback((message: string, undo?: () => void) => {
    setFlash(message)
    // Stored as a thunk: `setState` calls a bare function argument instead of
    // storing it, which would fire the undo the moment it was offered.
    setFlashUndo(undo ? () => undo : null)
  }, [])

  // Report the total still missing after scan reconciliation, including old misses
  const reportScanComplete = useCallback((missingTotal: number) => {
    const files = missingTotal === 1 ? 'file is' : 'files are'
    setFlash(`Scan complete: ${missingTotal} linked ${files} missing.`)
  }, [])

  const [mode, setMode] = useState<AppMode>('collection')
  // The Files surface has two scopes: browse the directory tree, or the flat
  // "Unbundled" to-bundle queue (a cross-library list of not-yet-bundled files).
  const [fileScope, setFileScope] = useState<'browse' | 'unbundled' | 'trash'>('browse')
  const [filePath, setFilePath] = useState('')
  const [fileEntry, setFileEntry] = useState<FileBrowserEntry | null>(null)
  // A file to highlight after "Locate in File Browser" (until the user navigates
  // or picks another entry), independent of the loaded fileEntry object.
  const [locatedPath, setLocatedPath] = useState<string | null>(null)

  // Apply a cairndex:// target once this workspace is mounted for the right
  // library. App owns the library switch and this component is keyed on
  // libraryId, so by the time a cross-library link reaches here the remount has
  // already happened.
  useEffect(() => {
    if (!deepLink) return
    /* eslint-disable react-hooks/set-state-in-effect -- the link is delivered by
       the OS, not by a React event. A cold-start link is parked by the shell and a
       cross-library link arrives only after this component has remounted, so there
       is no earlier callback to carry it; the parent clears the prop on handling,
       so this runs once and cannot cascade. */
    if (deepLink.unknownLibrary) {
      setFlash('This link points at a library that is not on this server.')
    } else if (deepLink.kind === 'bundle') {
      setMode('collection')
      setOpenBundleId(deepLink.id)
    } else {
      setMode('collection')
      setOpenBundleId(null)
      setSelection({ view: 'all', collectionId: deepLink.id })
    }
    /* eslint-enable react-hooks/set-state-in-effect */
    onDeepLinkHandled()
  }, [deepLink, onDeepLinkHandled])
  // Live snapshot of the running maintenance job so the
  // sidebar can render a determinate/indeterminate progress bar. Null when idle.
  const [activeJob, setActiveJob] = useState<JobRead | null>(null)
  // Reuses the snapshots the sidebar progress bar already polls, so a long
  // scan/probe/storyboard run can tell the owner it is done while they are away.
  useJobNotifications(activeJob)
  const platform = getHostPlatform()
  const hostLabels = getHostLabels()
  // Shares the Settings Libraries page's cache entry, so locate/clear there
  // flow through here without bespoke revision plumbing.
  const mappingQuery = useQuery({
    queryKey: ['library-mapping', libraryId],
    queryFn: () => platform.getLibraryMapping(libraryId),
    enabled:
      platform.canRevealInFinder || platform.canOpenWithDefaultApp || platform.canDragOutFiles,
  })
  const libraryMapped = mappingQuery.data != null
  // Tri-state for drag-in: 'pending' while the mapping resolves (e.g. right after
  // switching libraries) so a drop is deferred rather than mis-reported unmapped.
  const mappingState: DropMappingState = libraryMapped
    ? 'mapped'
    : mappingQuery.isLoading
      ? 'pending'
      : 'unmapped'

  const revealMappedFile = useCallback(
    (relativePath: string) => {
      void platform
        .revealFile(libraryId, relativePath)
        .catch((error: unknown) => setFlash(hostOperationErrorMessage(error)))
    },
    [libraryId, platform],
  )
  const openMappedFile = useCallback(
    (relativePath: string) => {
      void platform
        .openFile(libraryId, relativePath)
        .catch((error: unknown) => setFlash(hostOperationErrorMessage(error)))
    },
    [libraryId, platform],
  )
  const onRevealHostFile =
    libraryMapped && platform.canRevealInFinder ? revealMappedFile : undefined
  const onOpenHostFile =
    libraryMapped && platform.canOpenWithDefaultApp ? openMappedFile : undefined

  // Drag-out (plan 3 §6): a mapped desktop library can put its real files on the
  // OS pasteboard. The shell resolves + validates each server-provided relative
  // path; the web layer never handles an absolute path. Undefined disables every
  // drag-out source (plain web, or a library not located on this computer).
  const startFilesDrag = useCallback(
    (relativePaths: string[]) => {
      if (relativePaths.length === 0) return
      void platform
        .startFileDrag(relativePaths.map((relativePath) => ({ libraryId, relativePath })))
        .catch((error: unknown) => setFlash(hostOperationErrorMessage(error)))
    },
    [libraryId, platform],
  )
  const onStartFileDrag = platform.canDragOutFiles && libraryMapped ? startFilesDrag : undefined

  useDesktopMenu((action) => {
    if (action === 'new-bundle') setCreatingEmpty(true)
    else if (action === 'show-bundles') setMode('collection')
    else if (action === 'show-files') {
      setMode('file')
      setFileScope('browse')
    } else if (action === 'zoom-in') {
      setPrefs((previous) => ({ ...previous, zoom: Math.min(ZOOM_MAX, previous.zoom + 10) }))
    } else if (action === 'zoom-out') {
      setPrefs((previous) => ({ ...previous, zoom: Math.max(ZOOM_MIN, previous.zoom - 10) }))
    } else if (action === 'toggle-sidebar') {
      setPrefs((previous) => ({
        ...previous,
        sidebarVisible: !(previous.sidebarVisible ?? DEFAULT_PREFS.sidebarVisible),
      }))
    } else if (action === 'toggle-inspector') {
      setPrefs((previous) => ({
        ...previous,
        inspectorVisible: !(previous.inspectorVisible ?? DEFAULT_PREFS.inspectorVisible),
      }))
    }
  })

  const collections = useCollections()
  const smartCollections = useSmartCollections()
  const counts = useViewCounts()
  const collectionCounts = useCollectionCounts()
  const updateLibrary = useUpdateLibrary({
    onProgress: setActiveJob,
    onScanComplete: reportScanComplete,
    onGroupingPlan: (planId) => {
      setReviewPlanId(planId)
      setReviewingGrouping(true)
    },
  })
  const scanFiles = useScan({
    onProgress: setActiveJob,
    onScanComplete: reportScanComplete,
    onGroupingPlan: (planId) => {
      setReviewPlanId(planId)
      setReviewingGrouping(true)
    },
  })
  const probe = useProbe({ onProgress: setActiveJob })
  const storyboards = useStoryboards({ onProgress: setActiveJob })
  const deleteBundles = useDeleteBundles()
  const deleteCollection = useDeleteCollection()
  const createCollection = useCreateCollection()
  const renameCollection = useRenameCollection()
  const updateCollection = useUpdateCollection()
  const reorderCollections = useReorderCollections()
  const cleanupCollectionOrder = useCleanupCollectionOrder()
  const reorderBundles = useReorderBundles()
  const cleanupBundleOrder = useCleanupBundleOrder()
  const smartCollectionMutations = useSmartCollectionMutations()
  const batch = useBatchUpdate()
  const menu = useContextMenu()

  const libraryName = libraries.find((l) => l.id === libraryId)?.name ?? 'Library'
  // Write mode needs *both* gates to agree (ADR-0013 §1): the owner's
  // per-library opt-in and the deployment master switch. Either one off means
  // the File Browser looks exactly as it did before write mode existed.
  const writeModeAllowed = useDeploymentWriteMode()
  const writeMode =
    writeModeAllowed && (libraries.find((l) => l.id === libraryId)?.write_mode_enabled ?? false)
  // The sidebar's Trash entry outlives the capability: with write mode off, a
  // non-empty trash still lists (read-only), because files an owner deleted must
  // never *look* permanently gone. The peek query runs only when write mode is
  // off — on, the entry shows unconditionally and the listing is TrashView's job.
  const trashPeek = useTrash({ enabled: !writeMode && libraryId !== null })
  const showTrash = writeMode || (trashPeek.data?.operations ?? []).length > 0

  const activeSmartCollection =
    smartCollections.data?.find((sc) => sc.id === selection.smartCollectionId) ?? null

  // Debounce the toolbar search so each keystroke doesn't hit the backend; the
  // debounced value drives a whole-library FTS query (not a loaded-window filter).
  const [debouncedSearch, setDebouncedSearch] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 250)
    return () => clearTimeout(t)
  }, [search])

  // When viewing a collection, its direct subcollections are shown as folder
  // tiles above the grid; the toggle (persisted) decides whether the grid also
  // includes bundles from those subcollections. Off by default: a collection
  // shows only its own bundles, like a folder shows only its own files.
  const [showSubContents, setShowSubContents] = usePersistentState(
    'cairndex.showSubcollectionContents',
    false,
  )
  const [subcollapsed, setSubcollapsed] = useState(false)
  const [contentsCollapsed, setContentsCollapsed] = useState(false)
  // Subcollections selected (click or marquee) for their inspector, distinct
  // from navigating into one (double-click). A Set so drag-select can pick
  // several. Mutually exclusive with the bundle selection — selecting either
  // clears the other, since acting on both at once is meaningless.
  const [selectedCollectionIds, setSelectedCollectionIds] = useState<Set<string>>(new Set())
  // Which surface the collection selection was made on. The sidebar's highlight
  // already means "this is where you are"; lighting the same row up because its
  // card was clicked in the grid says the app navigated when it didn't. So the
  // tree shows a selection only when it was made *in* the tree, and the grid
  // shows one only when it was made in the grid.
  const [collectionSelectionFrom, setCollectionSelectionFrom] = useState<'grid' | 'sidebar'>('grid')
  // Each collection opens with both sections expanded (don't carry a fold from
  // the previously-viewed collection). Reset during render on change rather than
  // in an effect — React's "adjust state when a prop changes" pattern.
  const [foldedFor, setFoldedFor] = useState(selection.collectionId)
  if (foldedFor !== selection.collectionId) {
    setFoldedFor(selection.collectionId)
    setSubcollapsed(false)
    setContentsCollapsed(false)
    setSelectedCollectionIds(new Set())
  }
  // The folder cards shown above the grid: a collection's direct subcollections
  // when viewing one, or every root (top-level) collection in the All view. When
  // "Show subcollection contents" is on inside a collection, the section flattens
  // to *every* descendant collection (depth-first, manual order) so the folders
  // match the grid, which then shows the whole subtree's bundles.
  const isAllView =
    selection.view === 'all' && !selection.collectionId && !selection.smartCollectionId
  // Inside a collection, "Show subcollection contents" flattens every descendant
  // collection (depth-first, manual order) into the Subcollections section. The
  // All view has no such toggle — it always shows every top-level collection and,
  // in the grid, every bundle.
  const headerFlattened = showSubContents && selection.collectionId !== null
  const headerCollections = useMemo(() => {
    const all = collections.data ?? []
    const parentId = selection.collectionId ?? null
    if (parentId === null && !isAllView) return []
    // Manual order (shared with the sidebar), name as the stable tie-break.
    const bySortOrder = (a: CollectionRead, b: CollectionRead) =>
      a.sort_order - b.sort_order || a.name.localeCompare(b.name)
    if (headerFlattened && selection.collectionId) {
      const childrenOf = new Map<string, CollectionRead[]>()
      for (const c of all)
        if (c.parent_id) childrenOf.set(c.parent_id, [...(childrenOf.get(c.parent_id) ?? []), c])
      const flat: CollectionRead[] = []
      const walk = (pid: string) => {
        for (const child of (childrenOf.get(pid) ?? []).sort(bySortOrder)) {
          flat.push(child)
          walk(child.id)
        }
      }
      walk(selection.collectionId)
      return flat
    }
    return all.filter((c) => (c.parent_id ?? null) === parentId).sort(bySortOrder)
  }, [collections.data, selection.collectionId, isAllView, headerFlattened])

  // Direct subcollection count per collection id (for the card footers).
  const subCounts = useMemo(() => {
    const map: Record<string, number> = {}
    for (const c of collections.data ?? [])
      if (c.parent_id) map[c.parent_id] = (map[c.parent_id] ?? 0) + 1
    return map
  }, [collections.data])

  // Smart Collection filter AND the ad-hoc toolbar filter stack into one AST
  // (both compile to the same canonical shape). Null filters are ignored.
  const smartFilter = activeSmartCollection?.filter ?? null
  const combinedFilter = useMemo(
    () => combineFilters(smartFilter, adHocFiltersToExpression(adHocFilters)),
    [smartFilter, adHocFilters],
  )

  const includeSubContents = selection.collectionId !== null && showSubContents
  // Manual order scope: a single collection uses its own membership order; the
  // All/system views and a descendant-inclusive collection use the global order
  // (mirrors browse's MANUAL sort). Drives drag-reorder and "Clean up by…".
  const manualScopeCollectionId =
    selection.collectionId && !includeSubContents ? selection.collectionId : null

  // #8: the sort can be one global setting or remembered per collection/view.
  // This key buckets a smart collection / a collection / a system view (incl.
  // All) separately so each can keep its own last-used sort.
  const sortKey = selection.smartCollectionId
    ? `smart:${selection.smartCollectionId}`
    : selection.collectionId
      ? `coll:${selection.collectionId}`
      : `view:${selection.view}`
  // Recent ranks by a date, and *which* date is the whole choice the view
  // offers — Title or Size there would just be the All view under another name
  // (the server treats `recent` as All; only the ordering differs). So the sort
  // menu is narrowed to the three date orders, and a sort carried in from
  // another view falls back to Date Added rather than showing something the
  // menu can no longer express.
  const isRecentView = selection.view === 'recent' && selection.collectionId === null
  const allowedSorts: BundleSort[] = isRecentView ? RECENT_SORTS : STANDARD_SORTS
  const storedSort: SortPref =
    prefs.sortScope === 'collection'
      ? (prefs.collectionSorts[sortKey] ?? { sort: prefs.sort, order: prefs.order })
      : { sort: prefs.sort, order: prefs.order }
  // Manual has no direction. An order the owner arranged by hand *is* the
  // order; "manual descending" created a second coordinate system over the same
  // arrangement, and every reorder then had to translate between what the grid
  // displayed and what the storage meant — the class of bug behind drops
  // scrambling the grid and reloads disagreeing with what was on screen. Stored
  // prefs that still say manual+desc (possible from before this rule) are
  // coerced on read.
  const resolvedSort: SortPref = allowedSorts.includes(storedSort.sort)
    ? storedSort
    : isRecentView
      ? { sort: 'date_added', order: 'desc' }
      : { sort: 'manual', order: 'asc' }
  const effectiveSort: SortPref =
    resolvedSort.sort === 'manual' ? { sort: 'manual', order: 'asc' } : resolvedSort
  const setEffectiveSort = useCallback(
    (sort: BundleSort, order: SortOrder) => {
      if (prefs.sortScope === 'collection') {
        setPrefs({
          ...prefs,
          collectionSorts: { ...prefs.collectionSorts, [sortKey]: { sort, order } },
        })
      } else {
        setPrefs({ ...prefs, sort, order })
      }
    },
    [prefs, setPrefs, sortKey],
  )

  // The All tab shows every bundle flattened (its own system 'all' view) with the
  // top-level collection folders above — no per-view scoping.
  const browseView = selection.view
  const browse = useBrowse({
    view: browseView,
    collectionId: selection.collectionId,
    includeDescendants: includeSubContents,
    sort: effectiveSort.sort,
    order: effectiveSort.order,
    limit: 100,
    filter: combinedFilter,
    search: debouncedSearch.trim() || null,
  })

  // Context the toolbar's facet-count popovers need (each strips its own category).
  const facetContext: FacetContext = {
    view: browseView,
    collectionId: selection.collectionId,
    includeDescendants: includeSubContents,
    q: debouncedSearch.trim() || null,
    smartFilter,
  }

  // Backend search returns the matching page directly — no client-side filtering.
  const items = useMemo(() => browse.data?.pages.flatMap((p) => p.items) ?? [], [browse.data])
  const total = browse.data?.pages[0]?.total ?? 0
  const filtered = items

  // Exactly one subcollection selected → show its inspector; several → a small
  // multi-selection summary (see the right panel below).
  const singleSelectedCollectionId =
    selectedCollectionIds.size === 1 ? [...selectedCollectionIds][0] : null
  const selectedCollection = singleSelectedCollectionId
    ? (collections.data?.find((c) => c.id === singleSelectedCollectionId) ?? null)
    : null

  const title = useMemo(() => {
    if (activeSmartCollection) return activeSmartCollection.name
    if (selection.collectionId) {
      return collections.data?.find((c) => c.id === selection.collectionId)?.name ?? 'Collection'
    }
    return SYSTEM_VIEWS.find((v) => v.view === selection.view)?.label ?? 'All'
  }, [selection, collections.data, activeSmartCollection])

  // The one collection selection, shown only on the surface that made it. Both
  // are the same Set when they aren't empty, so everything that acts on the
  // selection (drag payloads, the context menu, the "N collections selected"
  // inspector) keeps reading `selectedCollectionIds` and stays surface-agnostic.
  const EMPTY_SELECTION = useMemo(() => new Set<string>(), [])
  const sidebarSelectedCollectionIds =
    collectionSelectionFrom === 'sidebar' ? selectedCollectionIds : EMPTY_SELECTION
  const gridSelectedCollectionIds =
    collectionSelectionFrom === 'grid' ? selectedCollectionIds : EMPTY_SELECTION

  const select = useCallback(
    (id: string, e: React.MouseEvent) => {
      // Shift+click: select the inclusive range from the anchor to this card,
      // over the current render order.
      if (e.shiftKey && bundleAnchor) {
        const ids = filtered.map((i) => i.id)
        const a = ids.indexOf(bundleAnchor)
        const b = ids.indexOf(id)
        if (a !== -1 && b !== -1) {
          const [lo, hi] = a < b ? [a, b] : [b, a]
          setSelectedIds(new Set(ids.slice(lo, hi + 1)))
          setActiveId(id)
          setSelectedCollectionIds(new Set())
          return
        }
      }
      if (e.metaKey || e.ctrlKey) {
        setSelectedIds((prev) => {
          const next = new Set(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      } else {
        setSelectedIds(new Set([id]))
      }
      // A plain/toggle click (re)sets the range anchor.
      setBundleAnchor(id)
      setActiveId(id)
      setSelectedCollectionIds(new Set())
    },
    [filtered, bundleAnchor],
  )

  // Marquee (drag-to-select) result from Browser — the full resulting
  // selection, already merged with the pre-drag selection when additive.
  // Always clears the subcollection selection (an empty result is an
  // empty-space click that deselects everything).
  const selectMany = useCallback((ids: string[]) => {
    setSelectedIds(new Set(ids))
    setActiveId(ids.length ? (ids[ids.length - 1] ?? null) : null)
    setSelectedCollectionIds(new Set())
  }, [])

  const open = useCallback((id: string) => {
    setSelectedIds(new Set([id]))
    setActiveId(id)
    setSelectedCollectionIds(new Set())
    setViewerTarget({ bundleId: id })
    void markBundleOpened(id)
  }, [])

  // Click a subcollection card (with modifier = toggle, Shift = range). Clears
  // the bundle selection to keep the two mutually exclusive.
  const selectCollection = useCallback(
    (id: string, e: React.MouseEvent) => {
      setCollectionSelectionFrom('grid')
      if (e.shiftKey && collectionAnchor) {
        const ids = headerCollections.map((c) => c.id)
        const a = ids.indexOf(collectionAnchor)
        const b = ids.indexOf(id)
        if (a !== -1 && b !== -1) {
          const [lo, hi] = a < b ? [a, b] : [b, a]
          setSelectedCollectionIds(new Set(ids.slice(lo, hi + 1)))
          setSelectedIds(new Set())
          setActiveId(null)
          return
        }
      }
      setSelectedCollectionIds((prev) => {
        // Cmd toggles. Deliberately not Ctrl: on macOS Ctrl-click is the
        // context-menu chord, so treating it as a toggle fought the menu.
        if (e.metaKey && collectionSelectionFrom === 'grid') {
          const next = new Set(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        }
        return new Set([id])
      })
      setCollectionAnchor(id)
      setSelectedIds(new Set())
      setActiveId(null)
    },
    [headerCollections, collectionAnchor, collectionSelectionFrom],
  )

  // Modifier-click on a sidebar collection row: toggle it in the sidebar's own
  // multi-selection, without navigating. A selection built in the grid is not
  // extended here — it isn't shown in the tree, so adding to it invisibly would
  // be a surprise; the first sidebar modifier-click starts fresh instead.
  const toggleCollectionFromSidebar = useCallback(
    (id: string) => {
      setSelectedCollectionIds((prev) => {
        const next = new Set(collectionSelectionFrom === 'sidebar' ? prev : [])
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
      setCollectionSelectionFrom('sidebar')
      setCollectionAnchor(id)
      setSelectedIds(new Set())
      setActiveId(null)
    },
    [collectionSelectionFrom],
  )

  // Marquee result over the subcollection cards — replaces the subcollection
  // selection wholesale and clears the bundle selection.
  const selectCollectionsMany = useCallback((ids: string[]) => {
    setCollectionSelectionFrom('grid')
    setSelectedCollectionIds(new Set(ids))
    setSelectedIds(new Set())
    setActiveId(null)
  }, [])

  // The sidebar's own Shift-range result. Same state, but tagged as the
  // sidebar's so the tree shows it (see `collectionSelectionFrom`).
  const selectCollectionsFromSidebar = useCallback((ids: string[]) => {
    setCollectionSelectionFrom('sidebar')
    setSelectedCollectionIds(new Set(ids))
    setSelectedIds(new Set())
    setActiveId(null)
  }, [])

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set())
    setActiveId(null)
  }, [])

  // Empty-space click: drop *both* selections. Which one is live depends on what
  // was last clicked, and blank space belongs to neither, so a single handler
  // clears the lot rather than leaving the other kind of selection stranded.
  const clearAllSelection = useCallback(() => {
    setSelectedIds(new Set())
    setActiveId(null)
    setSelectedCollectionIds(new Set())
  }, [])

  // Double-clicking a tag on the All Tags page: go to All bundles, clear the
  // text search, and apply a global Equal/direct tag filter (direct membership
  // only — no descendant expansion), whether the tag is a parent or a leaf.
  const applyTagFilterGlobally = useCallback((tagId: string) => {
    setMode('collection')
    setSelection({ view: 'all', collectionId: null })
    setSearch('')
    setAdHocFilters({
      tags: { rule: 'equal', includeDescendants: false, include: [tagId], exclude: [] },
      rating: null,
    })
    setSelectedIds(new Set())
    setActiveId(null)
    setSelectedCollectionIds(new Set())
    setOpenBundleId(null)
  }, [])

  // Right-click on a bundle card/row (Bundles surface). Operate on the whole
  // selection when the clicked card is part of a multi-selection; otherwise
  // target (and select) just this one. Deletion is confirmed in a dialog.
  const bundleContextMenu = useCallback(
    (id: string, e: React.MouseEvent) => {
      const targets = selectionTargets(id, selectedIds)
      const n = targets.length
      if (n === 1) {
        setSelectedIds(new Set([id]))
        setActiveId(id)
      }
      const items: MenuEntry[] = [
        { label: 'Play / View', onClick: () => open(id), disabled: n > 1 },
        {
          label: 'Open Bundle',
          onClick: () => {
            setOpenBundleId(id)
            void markBundleOpened(id)
            setViewerTarget(null)
          },
          disabled: n > 1,
        },
      ]
      // Desktop-only: a cairndex:// URI is meaningless in a browser, which has no
      // handler for the scheme.
      if (platform.kind === 'desktop' && n === 1) {
        items.push({
          label: 'Copy URI',
          onClick: () => {
            void copyText(buildDeepLinkUri('bundle', id, libraryId)).then((copied) =>
              setFlash(copied ? 'Bundle URI copied.' : 'Could not copy the URI.'),
            )
          },
        })
      }
      const hostPath =
        n === 1 ? filtered.find((item) => item.id === id)?.resume_relative_path : null
      if (hostPath) {
        const hostItems = hostFileMenuEntries(
          hostLabels,
          { onOpenFile: onOpenHostFile, onRevealFile: onRevealHostFile },
          hostPath,
        )
        if (hostItems.length > 0) items.push(null, ...hostItems)
      }
      if (selection.collectionId) {
        const collectionId = selection.collectionId
        items.push({
          label: 'Set as Collection Cover',
          disabled: n > 1,
          onClick: () =>
            updateCollection.mutate({ id: collectionId, patch: { cover_bundle_id: id } }),
        })
        items.push({
          label: n > 1 ? `Remove ${n} from This Collection` : 'Remove from This Collection',
          onClick: () =>
            batch.mutate({ bundle_ids: targets, remove_collection_ids: [collectionId] }),
        })
      }
      items.push(null, {
        label: n > 1 ? `Delete ${n} Bundles` : 'Delete Bundle',
        danger: true,
        onClick: () => setDeletingBundles(targets),
      })
      menu.open(e, items)
    },
    [
      selectedIds,
      selection.collectionId,
      open,
      batch,
      menu,
      updateCollection,
      filtered,
      hostLabels,
      onOpenHostFile,
      onRevealHostFile,
      platform.kind,
      libraryId,
    ],
  )

  // Files-surface context actions (Unbundled list or the directory tree) operate
  // on relative paths; unlinked paths are auto-linked server-side at apply.
  const bundleFilePaths = useCallback(
    (paths: string[]) => setAddingToBundle({ relativePaths: paths }),
    [],
  )
  const createBundleFromPaths = useCallback(
    (paths: string[]) => setCreatingBundle({ relativePaths: paths }),
    [],
  )

  // Drag-in (plan 3 §6 + plan 4 W5): files dropped from Finder that resolve
  // inside this mapped library land in the fast-add flow (Create Bundle); files
  // from *outside* it are copied in, which is what write mode made possible.
  // The hook ignores drops while any modal/viewer is open (P0-3).
  const queryClient = useQueryClient()
  const fileOperations = useFileOperations()
  const hostImports = useHostImports({
    libraryId,
    // Where a drop lands: the folder on screen when the Files surface is open,
    // the library root otherwise. Dropping onto a view of a folder and having
    // the file appear somewhere else would be the wrong kind of surprise.
    destDir: mode === 'file' && fileScope === 'browse' ? filePath : '',
    onFlash: showFlash,
    onImported: (operationId) => {
      // The file landed on disk through the shell, not the import *mutation*, so
      // nothing has invalidated the browser — do it here, the same refresh a
      // picker-added or web-dropped import gets, or the new file stays off screen
      // until the next navigation.
      invalidateAfterFileOperation(queryClient)
      return {
        // Reuses the same undo mutation the File Browser's toasts use, so a
        // desktop-dropped import is undone by exactly the same path — including
        // its cache invalidation — as one added through the picker.
        undo: () =>
          fileOperations.undo.mutate(operationId, {
            onSuccess: () => showFlash('Undone.'),
            onError: (error) =>
              showFlash(error instanceof Error ? error.message : 'That could not be undone.'),
          }),
      }
    },
  })

  // Rename the file shown in the inspector (double-click its title). A collision
  // is reported as a flash rather than the full Replace/Keep-both prompt — that
  // richer flow stays in the File Browser's own inline rename.
  const renameSelectedFile = (relativePath: string, newName: string) => {
    fileOperations.rename.mutate(
      { path: relativePath, newName, onConflict: undefined },
      {
        onSuccess: (result) => {
          const settled = result.path.split('/').pop() ?? result.path
          // Keep the open inspector in step with the name it landed on.
          setFileEntry((previous) =>
            previous && previous.relative_path === relativePath
              ? { ...previous, name: settled, relative_path: result.path }
              : previous,
          )
          showFlash(`Renamed to “${settled}”.`, () =>
            fileOperations.undo.mutate(result.operation.id, {
              onSuccess: () => showFlash('Undone.'),
              onError: (error) =>
                showFlash(error instanceof Error ? error.message : 'That could not be undone.'),
            }),
          )
        },
        onError: (failure) =>
          showFlash(failure instanceof Error ? failure.message : 'That name could not be used.'),
      },
    )
  }

  useDesktopFileDrop({
    libraryId,
    mappingState,
    reverseMap: reverseMapHostPaths,
    onFastAdd: createBundleFromPaths,
    onFlash: setFlash,
    // Copy the outside files in, but only when this library actually permits
    // writing. With write mode off the seam declines and the drop falls back to
    // the original explanation, which is still the true one for that library.
    onCopyIntoLibrary: writeMode
      ? (outsidePaths) => {
          hostImports.copyIn(outsidePaths)
          return true
        }
      : undefined,
  })

  // Right-click empty browser space → create a bundle, or clean up the bundle
  // manual order for the current scope.
  const emptyContextMenu = useCallback(
    (e: React.MouseEvent) => {
      menu.open(e, [
        { label: 'Create Bundle…', onClick: () => setCreatingEmpty(true) },
        null,
        {
          label: 'Clean Up Order…',
          onClick: () => setCleaningBundles(true),
          // A flattened list has no single manual order to tidy; everywhere
          // else does, the All view included.
          disabled: headerFlattened,
        },
      ])
    },
    [menu, headerFlattened],
  )

  const onManualBundlingApplied = useCallback(
    (message: string) => {
      setAddingToBundle(null)
      setCreatingBundle(null)
      setAddFilesBundleId(null)
      clearSelection()
      setFlash(message)
    },
    [clearSelection],
  )

  const confirmDeleteBundles = useCallback(
    (deleteFiles: boolean) => {
      const targets = deletingBundles
      if (!targets) return
      // Filesystem deletion isn't wired yet (metadata-only milestone); the
      // checkbox state is captured for a future write-enabled endpoint.
      void deleteFiles
      deleteBundles.mutate(targets, {
        onSuccess: () => {
          setDeletingBundles(null)
          clearSelection()
          if (openBundleId && targets.includes(openBundleId)) setOpenBundleId(null)
          if (viewerTarget && targets.includes(viewerTarget.bundleId)) setViewerTarget(null)
        },
      })
    },
    [deletingBundles, deleteBundles, clearSelection, openBundleId, viewerTarget],
  )

  // Removal is confirmed in a dialog (RemoveCollectionDialog) so the owner can
  // choose whether to also remove subcollections; the menu item just opens it.
  const removeCollection = useCallback(
    (collection: CollectionRead) => setRemovingCollections([collection]),
    [],
  )

  // Right-click a folder card in the main browser. Operate on the whole
  // subcollection selection when the clicked card is part of a multi-selection;
  // otherwise target (and select) just this one. Mirrors bundleContextMenu.
  const collectionContextMenu = useCallback(
    (id: string, e: React.MouseEvent) => {
      const targetIds = selectionTargets(id, selectedCollectionIds)
      if (targetIds.length === 1) {
        setSelectedCollectionIds(new Set([id]))
        setSelectedIds(new Set())
        setActiveId(null)
      }
      const n = targetIds.length
      const targets = (collections.data ?? []).filter((c) => targetIds.includes(c.id))
      const items: MenuEntry[] = []
      // Desktop-only: the scheme has no handler in a browser.
      if (platform.kind === 'desktop' && n === 1) {
        items.push({
          label: 'Copy URI',
          onClick: () => {
            void copyText(buildDeepLinkUri('collection', id, libraryId)).then((copied) =>
              setFlash(copied ? 'Collection URI copied.' : 'Could not copy the URI.'),
            )
          },
        })
        items.push(null)
      }
      items.push({
        label: n > 1 ? `Delete ${n} Collections` : 'Delete Collection',
        danger: true,
        onClick: () => setRemovingCollections(targets),
      })
      menu.open(e, items)
    },
    [selectedCollectionIds, collections.data, menu, platform.kind, libraryId],
  )

  // Which of the dragged collections may actually become children of
  // `newParentId`. The server rejects a collection parented to itself or to one
  // of its own descendants; dropping a multi-selection that happens to contain
  // the target's ancestor would otherwise surface as a bare error, so those are
  // dropped from the move here and the rest still goes through.
  const parentableInto = useCallback(
    (ids: string[], newParentId: string | null): string[] => {
      const parentOf = new Map((collections.data ?? []).map((c) => [c.id, c.parent_id ?? null]))
      const ancestorsOfTarget = new Set<string>()
      for (let at = newParentId; at !== null && at !== undefined; at = parentOf.get(at) ?? null) {
        if (ancestorsOfTarget.has(at)) break // corrupt cycle — stop rather than spin
        ancestorsOfTarget.add(at)
      }
      return ids.filter((id) => !ancestorsOfTarget.has(id))
    },
    [collections.data],
  )

  // Drag collections onto another → reparent them all into it. Ones that already
  // live there are left alone: dropping a mixed selection into a folder some of
  // it is already in shouldn't spend a write (and a refetch) saying so.
  const reparentCollections = useCallback(
    (ids: string[], newParentId: string | null) => {
      const parentOf = new Map((collections.data ?? []).map((c) => [c.id, c.parent_id ?? null]))
      for (const id of parentableInto(ids, newParentId)) {
        if (parentOf.get(id) === newParentId) continue
        updateCollection.mutate({ id, patch: { parent_id: newParentId } })
      }
    },
    [updateCollection, parentableInto, collections.data],
  )

  // Drop collections onto the gap before/after a row in a *different* parent
  // group (including the top level, newParentId=null): reparent them into that
  // group, then write the new sibling order. Reorder runs after the last
  // reparent commits so the backend's same-parent validation passes. This is
  // what makes "move a subcollection out to the top level" work.
  const moveCollections = useCallback(
    (ids: string[], newParentId: string | null, orderedIds: string[]) => {
      const moving = parentableInto(ids, newParentId)
      if (moving.length === 0) return
      // The caller built `orderedIds` from the whole dragged set, but a reorder
      // must list a sibling group exactly — so anything the cycle check refused
      // to move comes back out of the order too. (A refused id is an ancestor of
      // the new parent, which can never also be one of its children.)
      const order = orderedIds.filter((id) => moving.includes(id) || !ids.includes(id))
      let pending = moving.length
      const writeOrder = () => {
        if (--pending === 0) reorderCollections.mutate({ parentId: newParentId, orderedIds: order })
      }
      for (const id of moving) {
        updateCollection.mutate(
          { id, patch: { parent_id: newParentId } },
          { onSuccess: writeOrder },
        )
      }
    },
    [updateCollection, reorderCollections, parentableInto],
  )

  // Drop the dragged bundles onto a collection → add to it, and (unless Alt =
  // "add") remove them from the collection currently in view. Reads the dragged
  // bundle ids from the active dragItem.
  const moveBundlesToCollection = useCallback(
    (targetCollectionId: string, alt: boolean) => {
      if (dragItem?.kind !== 'bundles' || dragItem.ids.length === 0) return
      batch.mutate({
        bundle_ids: dragItem.ids,
        add_collection_ids: [targetCollectionId],
        remove_collection_ids: alt || !selection.collectionId ? [] : [selection.collectionId],
      })
      clearSelection()
    },
    [batch, dragItem, selection.collectionId, clearSelection],
  )

  // Right-click empty space in the subcollection section → clean up folder order.
  const collectionSectionContextMenu = useCallback(
    (e: React.MouseEvent) => {
      menu.open(e, [
        {
          label: 'Clean Up Order…',
          onClick: () => setCleaningCollections(true),
          disabled: headerFlattened,
        },
      ])
    },
    [menu, headerFlattened],
  )

  const confirmRemoveCollection = useCallback(
    (cascade: boolean) => {
      const targets = removingCollections
      if (!targets || targets.length === 0) return
      // When cascading, drop any target that is itself a descendant of another
      // selected target — its parent's cascade already removes it, so deleting it
      // again would 404.
      const ids = new Set(targets.map((t) => t.id))
      const effective = cascade
        ? targets.filter((t) => {
            let cur = t.parent_id
            while (cur) {
              if (ids.has(cur)) return false
              cur = collections.data?.find((c) => c.id === cur)?.parent_id ?? null
            }
            return true
          })
        : targets
      // Every collection whose view would become stale once these are gone.
      const affected = new Set<string>()
      for (const t of effective)
        for (const id of cascade ? collectionSubtreeIds(collections.data ?? [], t.id) : [t.id])
          affected.add(id)
      Promise.all(effective.map((t) => deleteCollection.mutateAsync({ id: t.id, cascade }))).then(
        () => {
          setRemovingCollections(null)
          setSelectedCollectionIds(new Set())
          if (selection.collectionId && affected.has(selection.collectionId)) {
            setSelection({ view: 'all', collectionId: null })
          }
        },
      )
    },
    [removingCollections, deleteCollection, collections.data, selection.collectionId],
  )

  const removeSmartCollection = useCallback(
    (sc: SmartCollectionRead) => {
      if (
        !window.confirm(`Delete smart collection “${sc.name}”? This removes the saved filter only.`)
      )
        return
      smartCollectionMutations.remove.mutate(sc.id, {
        onSuccess: () => {
          if (selection.smartCollectionId === sc.id) {
            setSelection({ view: 'all', collectionId: null })
          }
        },
      })
    },
    [smartCollectionMutations.remove, selection.smartCollectionId],
  )

  const moveSelection = useCallback(
    (delta: number) => {
      if (filtered.length === 0) return
      const idx = filtered.findIndex((i) => i.id === activeId)
      const next = Math.max(0, Math.min(filtered.length - 1, idx < 0 ? 0 : idx + delta))
      const target = filtered[next]
      if (target) {
        setSelectedIds(new Set([target.id]))
        setActiveId(target.id)
        document
          .querySelector(`[data-bundle-id="${target.id}"]`)
          ?.scrollIntoView({ block: 'nearest' })
      }
    },
    [filtered, activeId],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      if (openBundleId !== null) return
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault()
        moveSelection(1)
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault()
        moveSelection(-1)
      } else if (e.key === 'Escape') {
        clearSelection()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [moveSelection, clearSelection, openBundleId])

  return (
    <div
      className={`app${mode === 'tags' || !inspectorVisible ? ' app--no-inspector' : ''}`}
      style={
        {
          ['--sidebar-w']: sidebarVisible ? `${sidebarW}px` : '0px',
          ['--inspector-w']: `${inspectorW}px`,
        } as React.CSSProperties
      }
      // While an *internal* drag is live, the whole app accepts the dragover so
      // the cursor badge is consistent everywhere: the OS was showing a green
      // "+" over dead space (effectAllowed is copyMove, and an unhandled area
      // defaults to copy) and an arrow over real targets. Handling it here pins
      // the effect to move — or copy while ⌥ is held, matching the drop
      // semantics — wherever the pointer is. Finder file drags (types includes
      // Files) are left alone so drag-in keeps its own path, and the drop
      // swallow only ends stray drops; real targets handled the event first.
      onDragOver={
        dragItem
          ? (e) => {
              if (e.dataTransfer.types.includes('Files')) return
              e.preventDefault()
              e.dataTransfer.dropEffect = e.altKey ? 'copy' : 'move'
            }
          : undefined
      }
      onDrop={
        dragItem
          ? (e) => {
              if (e.dataTransfer.types.includes('Files')) return
              e.preventDefault()
            }
          : undefined
      }
    >
      {sidebarVisible && (
        <Sidebar
          mode={mode}
          onMode={(m) => {
            setMode(m)
            if (m === 'file') setFileScope('browse')
          }}
          fileScope={fileScope}
          onOpenUnbundled={() => {
            setMode('file')
            setFileScope('unbundled')
            setFileEntry(null)
          }}
          showTrash={showTrash}
          onOpenTrash={() => {
            setMode('file')
            setFileScope('trash')
            setFileEntry(null)
          }}
          onOpenAllTags={() => {
            setMode('tags')
            clearSelection()
            setSelectedCollectionIds(new Set())
            setOpenBundleId(null)
          }}
          libraries={libraries}
          libraryId={libraryId}
          onChangeLibrary={onChangeLibrary}
          onManageLibraries={onManage}
          onOpenSettings={onSettings}
          // A copy-in from a Finder drop is not scoped to any one pane, so its
          // progress is docked in the sidebar above Settings rather than injected
          // into whatever surface happens to be on screen.
          footer={hostImports.progress ? <ImportProgress {...hostImports.progress} /> : undefined}
          canLock={canLock}
          onLock={onLock}
          onUpdateLibrary={() => updateLibrary.mutate()}
          updating={updateLibrary.isPending}
          onScanFiles={() => scanFiles.mutate()}
          scanningFiles={scanFiles.isPending}
          onProbe={() => probe.mutate()}
          probing={probe.isPending}
          onGenerateStoryboards={() => storyboards.mutate()}
          generatingStoryboards={storyboards.isPending}
          activeJob={activeJob}
          maintenanceError={
            updateLibrary.error?.message ??
            scanFiles.error?.message ??
            probe.error?.message ??
            storyboards.error?.message ??
            null
          }
          onReviewGrouping={() => {
            setReviewPlanId(null)
            setReviewingGrouping(true)
          }}
          selection={selection}
          multiSelectedIds={sidebarSelectedCollectionIds}
          onModifierSelectCollection={toggleCollectionFromSidebar}
          onSelectCollectionsMany={selectCollectionsFromSidebar}
          onSelect={(s) => {
            setMode('collection')
            setSelection(s)
            clearSelection()
            setSelectedCollectionIds(new Set())
            setOpenBundleId(null)
          }}
          counts={counts.data}
          collections={collections.data ?? []}
          collectionCounts={collectionCounts.data}
          onDeleteCollection={removeCollection}
          onCreateCollection={(payload, callbacks) => createCollection.mutate(payload, callbacks)}
          onRenameCollection={(id, name, callbacks) =>
            renameCollection.mutate({ id, name }, callbacks)
          }
          onReorderCollections={(parentId, movedIds, beforeId) =>
            reorderCollections.mutate({ parentId, movedIds, beforeId })
          }
          onMoveCollections={moveCollections}
          onCleanupCollections={() => setCleaningCollections(true)}
          dragItem={dragItem}
          onDragItem={setDragItem}
          onReparentCollections={reparentCollections}
          onMoveBundlesInto={moveBundlesToCollection}
          onBackgroundClick={clearAllSelection}
          smartCollections={smartCollections.data ?? []}
          onNewSmartCollection={() => setEditor({ initialDraft: emptyDraft() })}
          onEditSmartCollection={(sc) => setEditor({ existing: sc })}
          onDeleteSmartCollection={removeSmartCollection}
        />
      )}

      <div className="center">
        {mode === 'tags' ? (
          <AllTagsPage onApplyTagFilter={applyTagFilterGlobally} />
        ) : mode === 'file' && fileScope === 'trash' ? (
          <TrashView writeMode={writeMode} onFlash={showFlash} />
        ) : mode === 'file' ? (
          <FileBrowser
            libraryName={libraryName}
            scope={fileScope === 'unbundled' ? 'unbundled' : 'browse'}
            path={filePath}
            selectedPath={locatedPath ?? fileEntry?.relative_path ?? null}
            onNavigate={(path) => {
              setFilePath(path)
              setFileEntry(null)
              setLocatedPath(null)
              setFileScope('browse')
            }}
            onSelectEntry={(entry) => {
              setFileEntry(entry)
              setLocatedPath(null)
            }}
            onAddToBundle={bundleFilePaths}
            onCreateBundle={createBundleFromPaths}
            hostLabels={hostLabels}
            onRevealFile={onRevealHostFile}
            onOpenFile={onOpenHostFile}
            onStartFileDrag={onStartFileDrag}
            writeMode={writeMode}
            onFlash={showFlash}
          />
        ) : (
          <>
            <Toolbar
              title={title}
              total={total}
              search={search}
              onSearch={setSearch}
              prefs={prefs}
              onPrefs={setPrefs}
              sort={effectiveSort.sort}
              order={effectiveSort.order}
              onSort={setEffectiveSort}
              allowedSorts={allowedSorts}
              perCollectionSort={prefs.sortScope === 'collection'}
              onPerCollectionSort={(v) =>
                setPrefs({ ...prefs, sortScope: v ? 'collection' : 'global' })
              }
              adHocFilters={adHocFilters}
              onAdHocFilters={setAdHocFilters}
              facetContext={facetContext}
            />
            {openBundleId ? (
              <BundleAlbum
                bundleId={openBundleId}
                playerPrefs={prefs.player}
                onPlayerPrefs={setPlayerPrefs}
                onBack={() => setOpenBundleId(null)}
                hostLabels={hostLabels}
                onRevealFile={onRevealHostFile}
                onOpenFile={onOpenHostFile}
                onStartFileDrag={onStartFileDrag}
                onLocateFile={(relativePath) => {
                  const dir = relativePath.includes('/')
                    ? relativePath.slice(0, relativePath.lastIndexOf('/'))
                    : ''
                  setMode('file')
                  setFileScope('browse')
                  setFilePath(dir)
                  setFileEntry(null)
                  setLocatedPath(relativePath)
                  setOpenBundleId(null)
                }}
              />
            ) : (
              <>
                {headerCollections.length > 0 && (
                  <CollectionHeader
                    subcollections={headerCollections}
                    sectionLabel={selection.collectionId ? 'Subcollections' : 'Collections'}
                    counts={collectionCounts.data}
                    subcounts={subCounts}
                    // The "Show subcollection contents" toggle only applies inside
                    // a collection; the All view has no such toggle.
                    showContents={selection.collectionId ? showSubContents : undefined}
                    onToggleShowContents={selection.collectionId ? setShowSubContents : undefined}
                    onSelectSubcollection={selectCollection}
                    onMarqueeSelect={selectCollectionsMany}
                    onContextMenuSubcollection={collectionContextMenu}
                    onSectionContextMenu={collectionSectionContextMenu}
                    dragItem={dragItem}
                    onDragItem={setDragItem}
                    onReparentCollections={reparentCollections}
                    onMoveCollections={moveCollections}
                    parentId={selection.collectionId ?? null}
                    onMoveBundlesInto={moveBundlesToCollection}
                    onReorderCollections={
                      // Reorder writes one sibling group; disabled in the
                      // flattened view where cards span multiple parents.
                      headerFlattened
                        ? undefined
                        : (movedIds, beforeId) =>
                            reorderCollections.mutate({
                              parentId: selection.collectionId ?? null,
                              movedIds,
                              beforeId,
                            })
                    }
                    onOpenSubcollection={(id) => {
                      setSelection({ view: 'all', collectionId: id })
                      clearSelection()
                      setSelectedCollectionIds(new Set())
                      setOpenBundleId(null)
                    }}
                    selectedIds={gridSelectedCollectionIds}
                    zoom={prefs.zoom}
                    subcollapsed={subcollapsed}
                    onToggleSubcollapsed={() => setSubcollapsed((v) => !v)}
                    contentsCount={total}
                    contentsCollapsed={contentsCollapsed}
                    onToggleContents={() => setContentsCollapsed((v) => !v)}
                  />
                )}
                {!(headerCollections.length > 0 && contentsCollapsed) && (
                  <Browser
                    items={filtered}
                    total={total}
                    searchQuery={debouncedSearch.trim() || undefined}
                    emptyState={
                      selection.collectionId && headerCollections.length > 0 && !showSubContents ? (
                        <>
                          <div>No bundles directly in this collection.</div>
                          <div>
                            Open a subcollection above, or tick “Show subcollection contents”.
                          </div>
                        </>
                      ) : selection.collectionId ? (
                        <>
                          <div>This collection is empty.</div>
                          <div>Add bundles to it from the grid or file view.</div>
                        </>
                      ) : undefined
                    }
                    layout={prefs.layout}
                    zoom={prefs.zoom}
                    selectedIds={selectedIds}
                    onSelect={select}
                    onMarqueeSelect={selectMany}
                    onOpen={open}
                    onContextMenu={bundleContextMenu}
                    contextMenuOpen={menu.state !== null}
                    onEmptyContextMenu={emptyContextMenu}
                    onReorder={
                      // Reordering only makes sense on a scoped, non-flattened
                      // list — a single collection's own bundles or a system-view
                      // queue. It's disabled when contents are flattened and in the
                      // All view (reordering "everything" is meaningless).
                      // Reorder wherever a manual order is well defined: a
                      // collection's own bundles, a system-view queue, and the
                      // All view — which *is* the global manual order, the one
                      // new bundles arrive at the front of. Only the flattened
                      // view is excluded: its cards span several parents, so
                      // dragging there would silently rewrite the global order
                      // while appearing to arrange one collection.
                      effectiveSort.sort === 'manual' && !headerFlattened
                        ? ({ movedIds, beforeId }) =>
                            reorderBundles.mutate({
                              collectionId: manualScopeCollectionId,
                              movedIds,
                              beforeId,
                            })
                        : undefined
                    }
                    onBundleDragStart={(ids) => setDragItem({ kind: 'bundles', ids })}
                    onBundleDragEnd={() => setDragItem(null)}
                    isLoading={browse.isLoading}
                    isError={browse.isError}
                    error={browse.error}
                    hasNextPage={browse.hasNextPage}
                    isFetchingNextPage={browse.isFetchingNextPage}
                    fetchNextPage={browse.fetchNextPage}
                  />
                )}
              </>
            )}
          </>
        )}
      </div>

      {mode === 'tags' || !inspectorVisible ? null : mode === 'file' ? (
        <FileInspector
          entry={fileEntry}
          hostLabels={hostLabels}
          onRevealFile={onRevealHostFile}
          onOpenFile={onOpenHostFile}
          onStartFileDrag={onStartFileDrag}
          onRename={writeMode && fileScope === 'browse' ? renameSelectedFile : undefined}
        />
      ) : selectedCollection ? (
        <CollectionInspector key={selectedCollection.id} collection={selectedCollection} />
      ) : isMultiSelection(selectedCollectionIds) ? (
        <aside className="inspector" data-tauri-drag-region>
          <div className="state">{selectedCollectionIds.size} collections selected</div>
        </aside>
      ) : isMultiSelection(selectedIds) ? (
        <MultiBundleInspector
          key={[...selectedIds].sort().join(',')}
          ids={[...selectedIds]}
          items={filtered.filter((i) => selectedIds.has(i.id))}
          onClear={clearSelection}
        />
      ) : (
        <Inspector
          bundleId={activeId}
          onAddFiles={(id) => setAddFilesBundleId(id)}
          onPlayBundle={(id) => setViewerTarget({ bundleId: id })}
          onPlayFile={(bundleId, fileId) => setViewerTarget({ bundleId, initialFileId: fileId })}
          onStartFileDrag={onStartFileDrag}
        />
      )}

      {sidebarVisible && (
        <Resizer side="left" width={sidebarW} setWidth={setSidebarW} min={180} max={400} />
      )}
      {mode !== 'tags' && inspectorVisible && (
        <Resizer side="right" width={inspectorW} setWidth={setInspectorW} min={220} max={480} />
      )}

      <ContextMenu state={menu.state} onClose={menu.close} />

      {viewerTarget && (
        <MediaViewer
          bundleId={viewerTarget.bundleId}
          initialFileId={viewerTarget.initialFileId}
          playerPrefs={prefs.player}
          onPlayerPrefs={setPlayerPrefs}
          onClose={() => setViewerTarget(null)}
        />
      )}

      {deletingBundles && (
        <DeleteBundlesDialog
          count={deletingBundles.length}
          pending={deleteBundles.isPending}
          filesReturnToUnbundled={selection.view !== 'unbundled'}
          onCancel={() => setDeletingBundles(null)}
          onConfirm={confirmDeleteBundles}
        />
      )}

      {cleaningCollections && (
        <CleanupOrderDialog
          title="Clean up collection order"
          description="Overwrite the manual order of every collection level with alphabetical order by name."
          choices={[
            { key: 'asc', label: 'Title (A–Z)' },
            { key: 'desc', label: 'Title (Z–A)' },
          ]}
          pending={cleanupCollectionOrder.isPending}
          onCancel={() => setCleaningCollections(false)}
          onConfirm={(key) =>
            cleanupCollectionOrder.mutate(key as 'asc' | 'desc', {
              onSuccess: () => setCleaningCollections(false),
            })
          }
        />
      )}

      {cleaningBundles && (
        <CleanupOrderDialog
          title="Clean up bundle order"
          description={
            manualScopeCollectionId
              ? 'Overwrite this collection’s manual order with a chosen sort.'
              : 'Overwrite the global manual order with a chosen sort.'
          }
          choices={[
            { key: 'title:asc', label: 'Title (A–Z)' },
            { key: 'title:desc', label: 'Title (Z–A)' },
            { key: 'date_added:desc', label: 'Date Added (newest first)' },
            { key: 'date_added:asc', label: 'Date Added (oldest first)' },
            { key: 'rating:desc', label: 'Rating (high → low)' },
            { key: 'rating:asc', label: 'Rating (low → high)' },
            { key: 'size:desc', label: 'Size (large → small)' },
            { key: 'size:asc', label: 'Size (small → large)' },
            { key: 'file_count:desc', label: 'File Count (most first)' },
            { key: 'file_count:asc', label: 'File Count (fewest first)' },
          ]}
          pending={cleanupBundleOrder.isPending}
          onCancel={() => setCleaningBundles(false)}
          onConfirm={(key) => {
            const [sort, order] = key.split(':') as [
              'date_added' | 'title' | 'rating' | 'size' | 'file_count',
              'asc' | 'desc',
            ]
            cleanupBundleOrder.mutate(
              { collectionId: manualScopeCollectionId, sort, order },
              {
                onSuccess: () => {
                  setCleaningBundles(false)
                  // Land on the manual order the cleanup just wrote.
                  setPrefs({ ...prefs, sort: 'manual', order: 'asc' })
                },
              },
            )
          }}
        />
      )}

      {removingCollections && (
        <RemoveCollectionDialog
          collections={removingCollections}
          hasChildren={(collections.data ?? []).some((c) =>
            removingCollections.some((t) => t.id === c.parent_id),
          )}
          pending={deleteCollection.isPending}
          onCancel={() => setRemovingCollections(null)}
          onConfirm={confirmRemoveCollection}
        />
      )}

      {reviewingGrouping && (
        <GroupingReview
          initialPlanId={reviewPlanId}
          onClose={() => {
            setReviewingGrouping(false)
            setReviewPlanId(null)
          }}
        />
      )}

      {editor && (
        <SmartCollectionEditor
          existing={editor.existing}
          initialDraft={editor.initialDraft}
          onClose={() => setEditor(null)}
          onSaved={(sc) => {
            setEditor(null)
            setSelection({ view: 'all', collectionId: null, smartCollectionId: sc.id })
            clearSelection()
          }}
        />
      )}

      {addingToBundle && (
        <AddToBundleDialog
          selection={addingToBundle}
          onClose={() => setAddingToBundle(null)}
          onApplied={onManualBundlingApplied}
        />
      )}

      {creatingBundle && (
        <CreateBundleDialog
          selection={creatingBundle}
          onClose={() => setCreatingBundle(null)}
          onApplied={onManualBundlingApplied}
        />
      )}

      {creatingEmpty && (
        <CreateEmptyBundleDialog
          onClose={() => setCreatingEmpty(false)}
          onCreated={(bundleId) => {
            // Chain into "add files" so the new empty bundle can pull in
            // suggested unbundled files (or be left empty).
            setCreatingEmpty(false)
            setAddFilesBundleId(bundleId)
            setFlash('Created an empty bundle.')
          }}
        />
      )}

      {addFilesBundleId && (
        <AddFilesToBundleDialog
          bundleId={addFilesBundleId}
          onClose={() => setAddFilesBundleId(null)}
          onApplied={onManualBundlingApplied}
        />
      )}

      {hostImports.conflict && (
        <ConflictDialog
          name={hostImports.conflict.conflictingName}
          onKeepBoth={hostImports.keepBoth}
          onReplace={hostImports.replace}
          onCancel={hostImports.dismiss}
          busy={false}
        />
      )}

      {flash && (
        <div className="mb-toast" role="status">
          {flash}
          {flashUndo && (
            <button
              className="btn btn--sm mb-toast__action"
              onClick={() => {
                flashUndo()
                setFlash(null)
                setFlashUndo(null)
              }}
            >
              Undo
            </button>
          )}
        </div>
      )}

      {/* While an item is being dragged, remind the owner of the drop semantics
          in the lower-left corner: plain drop = move, Option/Alt = copy (for
          bundles, "add to the collection without removing it from the current
          one"). Collections only move/reorder, so no copy hint there. */}
      {dragItem && (
        <div className="drag-hint" role="status" aria-live="polite">
          {dragItem.kind === 'bundles' ? (
            <>
              Drag to <strong>move</strong> · hold <kbd>⌥</kbd> to <strong>copy</strong>
            </>
          ) : (
            <>Drag and drop to reorder or nest</>
          )}
        </div>
      )}
    </div>
  )
}

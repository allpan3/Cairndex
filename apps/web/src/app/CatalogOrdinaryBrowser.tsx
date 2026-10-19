import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { CatalogQueryContext } from '../api/catalogQuery'
import { AllTagsPage } from './AllTagsPage'
import type { FileBrowserEntry, FileSelection, LibraryRead } from '../api/client'
import { useTags } from '../api/hooks'
import { useReplicaStatus } from '../api/useReplicaStatus'
import { getHostLabels, hostAltKeyHeld } from '../platform'
import { CatalogBundleBrowser } from './CatalogBundleBrowser'
import { CatalogNavigation } from './CatalogNavigation'
import { CollectionFromFolderDialog } from './CollectionFromFolderDialog'
import { FileBrowser } from './FileBrowser'
import { emptyAdHocFilters } from './adHocFilters'
import { DEFAULT_PLAYER_PREFS, type AppMode, type Selection } from './types'
import { visibleHierarchy } from './usePopover'
import { CatalogUnbundledBrowser } from './CatalogUnbundledBrowser'
import { CatalogFileDetails } from './CatalogFileDetails'
import { useLibraryHostFiles } from '../desktop/useLibraryHostFiles'
import { useHostFileMenu } from '../desktop/useHostFileMenu'
import { useIncomingFileDrop } from '../desktop/useIncomingFileDrop'
import type { PendingDeepLink } from './deepLinkUri'
import { installDragCopyTracking, setActiveDrag, type DragItem } from './dnd'
import { usePersistentState } from '../state/usePersistentState'
import { CatalogToast, type CatalogNotice } from './CatalogToast'
import { useCatalogCollections } from './useCatalogCollections'
import { useNavigationHistory } from './useNavigationHistory'
import { AddToBundleDialog, CreateBundleDialog } from './ManualBundlingDialogs'

/** One navigable place, for Back/Forward. */
interface Place {
  mode: AppMode
  selection: Selection
  unbundled: boolean
  path: string
}

const samePlace = (a: Place, b: Place) =>
  a.mode === b.mode &&
  a.selection.view === b.selection.view &&
  (a.selection.collectionId ?? null) === (b.selection.collectionId ?? null) &&
  (a.selection.smartCollectionId ?? null) === (b.selection.smartCollectionId ?? null) &&
  a.unbundled === b.unbundled &&
  a.path === b.path

function TagNavigation({ onSelect }: { onSelect: (id: string) => void }) {
  const tags = useTags()
  return (
    <section aria-label="Tags">
      <h2>All Tags</h2>
      {tags.isPending && <p>Loading tags…</p>}
      {tags.error && (
        <p role="alert">
          Tags are unavailable. <button onClick={() => void tags.refetch()}>Retry tags</button>
        </p>
      )}
      {tags.data?.length === 0 && <p>No tags.</p>}
      {visibleHierarchy(tags.data ?? [], new Set()).map(({ item, depth }) => (
        <button
          key={item.id}
          className="nav-item"
          style={{ paddingLeft: 12 + depth * 16 }}
          onClick={() => onSelect(item.id)}
        >
          {item.name}
        </button>
      ))}
    </section>
  )
}

import { SourceOperations } from './SourceOperations'
import { CatalogLibraryActions } from './CatalogLibraryActions'
import { InspectorToggle, SidebarToggle } from './PanelToggles'
import { PanelResizer } from './PanelResizer'
import { useDesktopMenu } from '../desktop/useDesktopMenu'
import type { MenuEntry } from './useContextMenu'

export function CatalogOrdinaryBrowser(props: {
  library: string
  libraries: LibraryRead[]
  editor: string
  selectionEnabled: boolean
  systemViewsEnabled: boolean
  albumEnabled: boolean
  inspectorEnabled: boolean
  sourceOperationsEnabled?: boolean
  blocked: boolean
  selected: string | null
  onSelect: (id: string) => void
  onReviewEntity: (family: string, id: string) => void
  onReview: () => void
  onOpen: (id: string) => void
  /** Open one file in the viewer, at `time` seconds when it is given. */
  onOpenFile: (bundle: string, file: string, time?: number) => void
  onChangeLibrary: (id: string) => void
  onManage: () => void
  onSettings?: () => void
  /** Make this browser's navigation action available to the sibling viewer rail. */
  onRegisterTagFilter?: (action: ((id: string) => void) | null) => void
  onRegisterFileNavigation?: (action: ((path: string, directory?: boolean) => void) | null) => void
  onRegisterCollectionNavigation?: (action: ((id: string) => void) | null) => void
  /** The workspace's viewer is open and shows the bundle inspector itself. */
  viewerOpen?: boolean
  /** A `cairndex://` link to open; reported handled once applied. */
  deepLink?: PendingDeepLink | null
  onDeepLinkHandled?: () => void
  /** The sidebar's Update button; absent when this server cannot run Update. */
  update?: { running: boolean; disabled: boolean; onClick: () => void }
  /** The ⋯ menu's library-wide entries, after this browser's file entries. */
  libraryMenu: MenuEntry[]
  /** Update's progress and status that needs the owner, in the sidebar footer;
   *  a result goes to the browser's message. */
  libraryNotices?: (onNotice: (notice: CatalogNotice) => void) => ReactNode
}) {
  const [mode, setMode] = useState<AppMode>('collection')
  const [fileOperations, setFileOperations] = useState(false)
  const [selection, setSelection] = useState<Selection>({ view: 'all', collectionId: null })
  const [filters, setFilters] = useState(emptyAdHocFilters)
  const [locateRequest, setLocateRequest] = useState(0)
  const [unbundled, setUnbundled] = useState(false)
  const [path, setPath] = useState('')
  const [file, setFile] = useState<FileBrowserEntry | null>(null)
  // A file the bundle menu asked to show; the File Browser selects it on arrival
  const [located, setLocated] = useState<string | null>(null)
  const [player, setPlayer] = useState(DEFAULT_PLAYER_PREFS)
  const [bundleHostPath, setBundleHostPath] = useState<string | null>(null)
  const [unbundledHostPath, setUnbundledHostPath] = useState<string | null>(null)
  const [incoming, setIncoming] = useState<File[] | null>(null)
  // The one transient message, at the foot of the window as v0.2.1 showed it
  const [notice, setNotice] = useState<CatalogNotice | null>(null)
  const dismissNotice = useCallback(() => setNotice(null), [])
  // A card drag's payload, for the sidebar's drop highlights; dnd.ts holds the live copy
  const [dragItem, setDragItem] = useState<DragItem | null>(null)
  const [newCollection, setNewCollection] = useState<{ parentId: string | null } | null>(null)
  const [renameCollection, setRenameCollection] = useState<{ id: string } | null>(null)
  const [folder, setFolder] = useState<string | null>(null)
  const [bundling, setBundling] = useState<{
    kind: 'create' | 'add'
    selection: FileSelection
  } | null>(null)
  const bundleSelection = (kind: 'create' | 'add') => (paths: string[], ids: string[]) =>
    setBundling({ kind, selection: { fileIds: ids, relativePaths: paths } })
  const bundled = (message: string) => {
    setBundling(null)
    setFile(null)
    setNotice({ text: message })
  }
  // Off by default, as in v0.2.1: a collection lists its own bundles, like a folder
  const [showSubContents, setShowSubContents] = usePersistentState(
    'cairndex.showSubcollectionContents',
    false,
  )
  // The panels as v0.2.1 kept them: shown or hidden from the View menu and
  // their toggles, and resized by dragging their inner edge
  const [panels, setPanels] = usePersistentState('cairndex.panels', {
    sidebar: true,
    inspector: true,
  })
  const [sidebarW, setSidebarW] = usePersistentState('cairndex.sidebarW', 240)
  const [inspectorW, setInspectorW] = usePersistentState('cairndex.inspectorW', 300)
  const toggleSidebar = () => setPanels((previous) => ({ ...previous, sidebar: !previous.sidebar }))
  const toggleInspector = () =>
    setPanels((previous) => ({ ...previous, inspector: !previous.inspector }))
  const updateDragItem = useCallback((item: DragItem | null) => {
    setActiveDrag(item)
    setDragItem(item)
  }, [])
  // All Tags deliberately starts a global Equal/direct filter.
  const showTag = useCallback((id: string) => {
    setFilters({
      ...emptyAdHocFilters(),
      tags: { rule: 'equal', includeDescendants: false, include: [id], exclude: [] },
    })
    setSelection({ view: 'all', collectionId: null })
    setMode('collection')
    setLocateRequest((value) => value + 1)
  }, [])
  const { onRegisterTagFilter } = props
  // Inspector chips keep the current place and other filters, with subtags included.
  const filterFromChip = useCallback((id: string) => {
    setFilters((previous) => ({
      ...previous,
      tags: { ...emptyAdHocFilters().tags, include: [id] },
    }))
    setUnbundled(false)
    setMode('collection')
  }, [])
  useEffect(() => {
    onRegisterTagFilter?.(filterFromChip)
    return () => onRegisterTagFilter?.(null)
  }, [onRegisterTagFilter, filterFromChip])
  const navigateFiles = useCallback((relative: string, directory = false) => {
    setPath(
      directory
        ? relative
        : relative.includes('/')
          ? relative.slice(0, relative.lastIndexOf('/'))
          : '',
    )
    setFile(null)
    setLocated(directory ? null : relative)
    setUnbundled(false)
    setMode('file')
  }, [])
  const { onRegisterFileNavigation } = props
  useEffect(() => {
    onRegisterFileNavigation?.(navigateFiles)
    return () => onRegisterFileNavigation?.(null)
  }, [onRegisterFileNavigation, navigateFiles])
  // The drop reads Option/Alt (add, do not move) from whichever signal the engine delivers
  useEffect(() => installDragCopyTracking(document, hostAltKeyHeld), [])
  const openPlace = useCallback((next: Selection) => {
    setUnbundled(false)
    setSelection(next)
    // A filter left over from the last place would quietly empty this one
    setFilters(emptyAdHocFilters())
    setMode('collection')
  }, [])
  const openCollection = useCallback(
    (id: string) => openPlace({ view: 'all', collectionId: id }),
    [openPlace],
  )
  const { onRegisterCollectionNavigation } = props
  useEffect(() => {
    onRegisterCollectionNavigation?.(openCollection)
    return () => onRegisterCollectionNavigation?.(null)
  }, [onRegisterCollectionNavigation, openCollection])
  const collections = useCatalogCollections(props.library, {
    selection,
    onSelect: openPlace,
    onNotice: setNotice,
    dragItem,
  })
  const place = useMemo(
    () => ({ mode, selection, unbundled, path }),
    [mode, selection, unbundled, path],
  )
  const history = useNavigationHistory(place, samePlace, (next) => {
    setMode(next.mode)
    setSelection(next.selection)
    setUnbundled(next.unbundled)
    setPath(next.path)
    setFile(null)
    setLocated(null)
  })
  // The sidebar's toggle rides in its own top row while it is open, and moves
  // into the toolbar when it is not; the inspector's ends the toolbar
  const headerLeading = (
    <>
      {!panels.sidebar && <SidebarToggle visible={false} onToggle={toggleSidebar} />}
      {history}
    </>
  )
  const headerTrailing = <InspectorToggle visible={panels.inspector} onToggle={toggleInspector} />
  useDesktopMenu((action) => {
    if (action === 'toggle-sidebar') toggleSidebar()
    else if (action === 'toggle-inspector') toggleInspector()
    else if (action === 'show-bundles' || action === 'new-bundle') {
      setUnbundled(false)
      setMode('collection')
    } else if (action === 'show-files') {
      setUnbundled(false)
      setMode('file')
    } else if (action === 'new-collection' && !props.blocked) {
      // The sidebar asks for the name, so it must be open
      setPanels((previous) => ({ ...previous, sidebar: true }))
      setNewCollection({ parentId: null })
    }
  })
  const status = useReplicaStatus(props.library).data
  const bundleMoves = (status?.selection_version ?? 0) >= 2 && !props.blocked
  const folderCollections = (status?.browse_version ?? 0) >= 7 && !props.blocked
  const tagManagement = (status?.browse_version ?? 0) >= 8 && !props.blocked
  const manualBundling = (status?.browse_version ?? 0) >= 9 && !props.blocked
  const { deepLink, onDeepLinkHandled, onSelect } = props
  // A bundle link selects and locates the bundle; a collection link opens the collection
  useEffect(() => {
    if (!deepLink) return
    /* eslint-disable react-hooks/set-state-in-effect -- the OS delivers the link,
       not a React event, and App clears it once handled, so this runs once. */
    if (deepLink.unknownLibrary) {
      setNotice({ text: 'This link points at a library that is not on this server.', alert: true })
    } else {
      setUnbundled(false)
      setMode('collection')
      if (deepLink.kind === 'bundle') {
        setSelection({ view: 'all', collectionId: null })
        onSelect(deepLink.id)
        setLocateRequest((value) => value + 1)
      } else {
        setSelection({ view: 'all', collectionId: deepLink.id })
      }
      setFilters(emptyAdHocFilters())
    }
    /* eslint-enable react-hooks/set-state-in-effect */
    onDeepLinkHandled?.()
  }, [deepLink, onDeepLinkHandled, onSelect])
  const sourceEnabled = Boolean(props.sourceOperationsEnabled && !props.blocked)
  const libraryName = props.libraries.find((item) => item.id === props.library)?.name ?? 'Library'
  const incomingDrop = useIncomingFileDrop(sourceEnabled, setIncoming, (text) =>
    setNotice(text ? { text, alert: true } : null),
  )
  const hostFiles = useLibraryHostFiles(
    props.library,
    props.libraries.find((item) => item.id === props.library),
  )
  useHostFileMenu(
    mode === 'collection'
      ? bundleHostPath
      : mode === 'file'
        ? unbundled
          ? unbundledHostPath
          : file?.kind === 'file'
            ? file.relative_path
            : null
        : null,
    hostFiles,
  )
  return (
    <CatalogQueryContext value={props.library}>
      <div
        className={`catalog-ordinary-layout${panels.sidebar ? '' : ' catalog-ordinary-layout--no-sidebar'}${
          panels.inspector && mode !== 'tags' ? '' : ' catalog-ordinary-layout--no-inspector'
        }`}
        style={
          {
            '--sidebar-w': `${sidebarW}px`,
            '--inspector-w': `${inspectorW}px`,
          } as React.CSSProperties
        }
        {...incomingDrop}
      >
        {panels.sidebar && (
          <CatalogNavigation
            editor={props.editor}
            library={props.library}
            libraries={props.libraries}
            mode={mode}
            onMode={(next) => {
              setMode(next)
              setUnbundled(false)
            }}
            systemViewsEnabled={props.systemViewsEnabled}
            unbundled={unbundled}
            onUnbundled={() => {
              setUnbundled(true)
              setMode('file')
            }}
            selection={selection}
            onSelect={openPlace}
            onChangeLibrary={props.onChangeLibrary}
            onManage={props.onManage}
            onSettings={props.onSettings}
            onReview={props.onReview}
            onReviewEntity={props.onReviewEntity}
            blocked={props.blocked}
            dragItem={dragItem}
            onDragItem={updateDragItem}
            bundleMovesEnabled={bundleMoves}
            newCollectionRequest={newCollection}
            onNewCollectionHandled={() => setNewCollection(null)}
            renameCollectionRequest={renameCollection}
            onRenameCollectionHandled={() => setRenameCollection(null)}
            collections={collections}
            onNotice={setNotice}
            activity={props.libraryNotices?.(setNotice)}
            libraryActions={
              <CatalogLibraryActions
                update={
                  props.update && {
                    ...props.update,
                    // A new run replaces the last run's result
                    onClick: () => {
                      setNotice(null)
                      props.update?.onClick()
                    },
                  }
                }
                items={[
                  ...(sourceEnabled
                    ? [
                        { label: 'Add Files…', onClick: () => setFileOperations(true) },
                        { label: 'File Operations…', onClick: () => setFileOperations(true) },
                        null,
                      ]
                    : []),
                  ...props.libraryMenu,
                ]}
              />
            }
            onToggleSidebar={toggleSidebar}
          />
        )}
        <div className="catalog-ordinary-content">
          {sourceEnabled && (
            <SourceOperations
              library={props.library}
              editor={props.editor}
              file={mode === 'file' && !unbundled ? file : null}
              directory={mode === 'file' && !unbundled ? path : ''}
              onReviewEntity={props.onReviewEntity}
              incoming={incoming}
              onDismissIncoming={() => setIncoming(null)}
              open={fileOperations}
              onOpen={() => setFileOperations(true)}
              onClose={() => setFileOperations(false)}
            />
          )}
          <div hidden={mode !== 'collection'} className="catalog-bundle-surface">
            <CatalogBundleBrowser
              {...props}
              hostFiles={hostFiles}
              onHostPath={setBundleHostPath}
              onLocateFile={(relative) => navigateFiles(relative)}
              onOpenDirectory={(relative) => navigateFiles(relative, true)}
              onBundleDrag={
                bundleMoves ? (ids) => updateDragItem(ids && { kind: 'bundles', ids }) : undefined
              }
              onNewCollection={(parentId) => setNewCollection({ parentId })}
              collections={collections}
              showSubContents={showSubContents}
              onShowSubContents={setShowSubContents}
              onOpenCollection={openCollection}
              onFilterTag={filterFromChip}
              onRenameCollection={(id) => setRenameCollection({ id })}
              dragItem={dragItem}
              onDragItem={updateDragItem}
              bundleMovesEnabled={bundleMoves}
              onNotice={setNotice}
              headerLeading={headerLeading}
              headerTrailing={headerTrailing}
              onScreen={mode === 'collection'}
              locateRequest={locateRequest}
              selection={selection}
              filters={filters}
              onFilters={setFilters}
            />
          </div>
          {mode === 'tags' &&
            (tagManagement ? (
              <AllTagsPage onApplyTagFilter={showTag} />
            ) : (
              <TagNavigation onSelect={showTag} />
            ))}
          {mode === 'file' && unbundled && (
            <CatalogUnbundledBrowser
              library={props.library}
              libraryName={libraryName}
              onReview={props.onReview}
              onNotice={setNotice}
              hostFiles={hostFiles}
              onHostPath={setUnbundledHostPath}
              headerLeading={headerLeading}
              headerTrailing={headerTrailing}
              bundling={manualBundling}
            />
          )}
          {mode === 'file' && !unbundled && (
            <div className="catalog-file-surface">
              <FileBrowser
                catalogLibrary={props.library}
                catalogPathBundling={(status?.browse_version ?? 0) >= 13 && !props.blocked}
                libraryName={libraryName}
                headerLeading={headerLeading}
                headerTrailing={headerTrailing}
                onFlash={(text) => setNotice({ text })}
                scope="browse"
                path={path}
                selectedPath={located ?? file?.relative_path ?? null}
                onNavigate={(next) => {
                  setPath(next)
                  setFile(null)
                  setLocated(null)
                }}
                onSelectEntry={(entry) => {
                  setLocated(null)
                  setFile(entry)
                }}
                onCollectionFromFolder={folderCollections ? setFolder : undefined}
                onAddToBundle={bundleSelection('add')}
                onCreateBundle={bundleSelection('create')}
                hostLabels={getHostLabels()}
                onRevealFile={hostFiles.onRevealFile}
                onOpenFile={hostFiles.onOpenFile}
                onStartFileDrag={hostFiles.onStartFileDrag}
                playerPrefs={player}
                onPlayerPrefs={setPlayer}
                onLocateBundle={(id) => {
                  props.onSelect(id)
                  setLocateRequest((value) => value + 1)
                  setMode('collection')
                }}
              />
              <aside className="inspector" aria-label="File inspector">
                {file ? (
                  <>
                    <h2>{file.name}</h2>
                    <p>{file.relative_path}</p>
                    {props.inspectorEnabled && file.file_id && (
                      <CatalogFileDetails
                        key={file.file_id}
                        library={props.library}
                        file={file.file_id}
                        hostFiles={hostFiles}
                      />
                    )}
                    <p>
                      {file.linked ? 'Cataloged' : 'Unlinked'} ·{' '}
                      {file.local_state === 'observed'
                        ? 'Observed on this device'
                        : file.local_state === 'unavailable'
                          ? 'Unavailable on this device'
                          : 'Availability is unknown on this device'}
                    </p>
                    {file.bundle_id && (
                      <button
                        onClick={() => {
                          props.onSelect(file.bundle_id!)
                          setLocateRequest((value) => value + 1)
                          setMode('collection')
                        }}
                      >
                        Locate in Bundle Browser
                      </button>
                    )}
                    {!file.linked && status?.path_media_version !== 1 && (
                      <p>Update the server to preview unindexed files.</p>
                    )}
                  </>
                ) : (
                  <p>Select a file to see its details.</p>
                )}
              </aside>
            </div>
          )}
        </div>
        {panels.sidebar && (
          <PanelResizer side="left" width={sidebarW} setWidth={setSidebarW} min={180} max={400} />
        )}
        {panels.inspector && mode !== 'tags' && (
          <PanelResizer
            side="right"
            width={inspectorW}
            setWidth={setInspectorW}
            min={220}
            max={480}
          />
        )}
      </div>
      {folder !== null && (
        <CollectionFromFolderDialog
          directory={folder}
          onClose={() => setFolder(null)}
          onCreated={(collection, added) => {
            // The point of the action is the collection, so land in it, as legacy did
            setFolder(null)
            setUnbundled(false)
            setSelection({ view: 'all', collectionId: collection.id })
            setMode('collection')
            setNotice({
              text:
                added === 1
                  ? `Created “${collection.name}” with 1 bundle.`
                  : `Created “${collection.name}” with ${added} bundles.`,
            })
          }}
        />
      )}
      {bundling?.kind === 'create' && (
        <CreateBundleDialog
          selection={bundling.selection}
          onClose={() => setBundling(null)}
          onApplied={bundled}
        />
      )}
      {bundling?.kind === 'add' && (
        <AddToBundleDialog
          selection={bundling.selection}
          onClose={() => setBundling(null)}
          onApplied={bundled}
        />
      )}
      <CatalogToast
        notice={notice ?? (hostFiles.error ? { text: hostFiles.error, alert: true } : null)}
        onDismiss={notice ? dismissNotice : hostFiles.dismissError}
      />
    </CatalogQueryContext>
  )
}

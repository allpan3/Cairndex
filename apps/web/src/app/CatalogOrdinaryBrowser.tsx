import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CatalogQueryContext } from '../api/catalogQuery'
import { AllTagsPage } from './AllTagsPage'
import type { FileBrowserEntry, FileSelection, LibraryRead } from '../api/client'
import { useTags, useWriteMode } from '../api/hooks'
import { useReplicaStatus } from '../api/useReplicaStatus'
import { getHostLabels, hostAltKeyHeld } from '../platform'
import { CatalogBundleBrowser } from './CatalogBundleBrowser'
import { CatalogNavigation } from './CatalogNavigation'
import { CollectionFromFolderDialog } from './CollectionFromFolderDialog'
import { FileBrowser } from './FileBrowser'
import { emptyAdHocFilters } from './adHocFilters'
import { DEFAULT_PLAYER_PREFS, type AppMode, type LocatedFile, type Selection } from './types'
import { visibleHierarchy } from './usePopover'
import { CatalogUnbundledBrowser } from './CatalogUnbundledBrowser'
import { CatalogFileDetails } from './CatalogFileDetails'
import { useLibraryHostFiles } from '../desktop/useLibraryHostFiles'
import { useHostFileMenu } from '../desktop/useHostFileMenu'
import { incomingFilesError, useIncomingFileDrop } from '../desktop/useIncomingFileDrop'
import type { PendingDeepLink } from './deepLinkUri'
import { installDragCopyTracking, setActiveDrag, type DragItem } from './dnd'
import { usePersistentState } from '../state/usePersistentState'
import { CatalogToast, type CatalogNotice } from './CatalogToast'
import { useCatalogCollections } from './useCatalogCollections'
import { useNavigationHistory } from './useNavigationHistory'
import { AddToBundleDialog, CreateBundleDialog } from './ManualBundlingDialogs'
import { IncomingDialog, type IncomingTarget, type IncomingDropContext } from './IncomingDialog'
import { SourceTaskProgress } from './SourceTaskProgress'
import { useSourceTasks } from './useSourceTasks'
import { newFolderTask, renameError, renameTask } from './sourceActions'
import { RelocateDialog, TrashDialog } from './SourceActionDialogs'
import { CatalogTrashBrowser } from './CatalogTrashBrowser'
import { useTrash, useUnfinishedOperations } from './useSourceLists'
import { UnfinishedOperations } from './UnfinishedOperations'
import { isBlockingSurfaceOpen } from '../desktop/fileDrop'

/** One navigable place, for Back/Forward. */
interface Place {
  mode: AppMode
  selection: Selection
  scope: FileScope
  path: string
}

/** What the Files surface lists: a folder, the Unbundled queue or the Trash. */
type FileScope = 'browse' | 'unbundled' | 'trash'

const samePlace = (a: Place, b: Place) =>
  a.mode === b.mode &&
  a.selection.view === b.selection.view &&
  (a.selection.collectionId ?? null) === (b.selection.collectionId ?? null) &&
  (a.selection.smartCollectionId ?? null) === (b.selection.smartCollectionId ?? null) &&
  a.scope === b.scope &&
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

import { CatalogLibraryActions } from './CatalogLibraryActions'
import { InspectorToggle, SidebarToggle } from './PanelToggles'
import { PanelResizer } from './PanelResizer'
import { RefreshButton } from './RefreshButton'
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
  /** Open Metadata Review on one structural conflict. */
  onReviewConflict?: (unit: string) => void
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
  update?: { running: boolean; initialScan?: boolean; disabled: boolean; onClick: () => void }
  /** The ⋯ menu's library-wide entries, after this browser's file entries. */
  libraryMenu: MenuEntry[]
  /** Update's progress and status that needs the owner, in the sidebar footer;
   *  a result goes to the browser's message. */
  libraryNotices?: (onNotice: (notice: CatalogNotice) => void) => ReactNode
}) {
  const [mode, setMode] = useState<AppMode>('collection')
  const [selection, setSelection] = useState<Selection>({ view: 'all', collectionId: null })
  const [filters, setFilters] = useState(emptyAdHocFilters)
  const [locateRequest, setLocateRequest] = useState(0)
  // The file Locate in Bundle Browser opens its bundle on
  const [locateFile, setLocateFile] = useState<LocatedFile | null>(null)
  const [fileScope, setFileScope] = useState<FileScope>('browse')
  const unbundled = fileScope === 'unbundled'
  const [path, setPath] = useState('')
  const [file, setFile] = useState<FileBrowserEntry | null>(null)
  // A file the bundle menu asked to show; the File Browser selects it on arrival
  const [located, setLocated] = useState<string | null>(null)
  const [player, setPlayer] = useState(DEFAULT_PLAYER_PREFS)
  const [bundleHostPath, setBundleHostPath] = useState<string | null>(null)
  const [unbundledHostPath, setUnbundledHostPath] = useState<string | null>(null)
  const [incoming, setIncoming] = useState<{ files: File[]; target: IncomingTarget } | null>(null)
  const [action, setAction] = useState<{
    kind: 'copy' | 'move' | 'trash'
    paths: string[]
  } | null>(null)
  const filePicker = useRef<HTMLInputElement>(null)
  // The open bundle takes precedence over its enclosing collection.
  const dropContext = useRef<IncomingDropContext>({
    collection: null,
    home: null,
    bundle: null,
  })
  const onDropContext = useCallback((context: IncomingDropContext) => {
    dropContext.current = context
  }, [])
  // The folder the last files went to, per library, for drops with no better hint
  const [lastFolders, setLastFolders] = usePersistentState<Record<string, string>>(
    'cairndex.incomingFolders',
    {},
  )
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
    setLocateFile(null)
    setLocateRequest((value) => value + 1)
  }, [])
  const { onRegisterTagFilter } = props
  // Inspector chips keep the current place and other filters, with subtags included.
  const filterFromChip = useCallback((id: string) => {
    setFilters((previous) => ({
      ...previous,
      tags: { ...emptyAdHocFilters().tags, include: [id] },
    }))
    setFileScope('browse')
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
    setFileScope('browse')
    setMode('file')
  }, [])
  // Locate in Bundle Browser, as in v0.2.1: All bundles, no filters, the bundle
  // selected and opened, here also on the located file
  const { onSelect } = props
  const locate = useCallback(
    (bundle: string, located: LocatedFile | null) => {
      setSelection({ view: 'all', collectionId: null })
      setFilters(emptyAdHocFilters())
      setFileScope('browse')
      onSelect(bundle)
      setLocateFile(located)
      setLocateRequest((value) => value + 1)
      setMode('collection')
    },
    [onSelect],
  )
  const { onRegisterFileNavigation } = props
  useEffect(() => {
    onRegisterFileNavigation?.(navigateFiles)
    return () => onRegisterFileNavigation?.(null)
  }, [onRegisterFileNavigation, navigateFiles])
  // The drop reads Option/Alt (add, do not move) from whichever signal the engine delivers
  useEffect(() => installDragCopyTracking(document, hostAltKeyHeld), [])
  const openPlace = useCallback((next: Selection) => {
    setFileScope('browse')
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
    () => ({ mode, selection, scope: fileScope, path }),
    [mode, selection, fileScope, path],
  )
  const history = useNavigationHistory(place, samePlace, (next) => {
    setMode(next.mode)
    setSelection(next.selection)
    setFileScope(next.scope)
    setPath(next.path)
    setFile(null)
    setLocated(null)
  })
  // The sidebar's toggle rides in its own top row while it is open, and moves
  // into the toolbar when it is not; the inspector's ends the toolbar. Refresh
  // follows Back/Forward, as Reload does in a web browser.
  const headerLeading = (
    <>
      {!panels.sidebar && <SidebarToggle visible={false} onToggle={toggleSidebar} />}
      {history}
      <RefreshButton />
    </>
  )
  const headerTrailing = <InspectorToggle visible={panels.inspector} onToggle={toggleInspector} />
  const sourceEnabled = Boolean(props.sourceOperationsEnabled && !props.blocked)
  useDesktopMenu((action) => {
    if (action === 'toggle-sidebar') toggleSidebar()
    else if (action === 'toggle-inspector') toggleInspector()
    else if (action === 'show-bundles' || action === 'new-bundle') {
      setFileScope('browse')
      setMode('collection')
    } else if (action === 'show-files') {
      setFileScope('browse')
      setMode('file')
    } else if (action === 'add-files' && sourceEnabled && !isBlockingSurfaceOpen()) {
      filePicker.current?.click()
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
  const { deepLink, onDeepLinkHandled } = props
  // A bundle link selects and locates the bundle; a collection link opens the collection
  useEffect(() => {
    if (!deepLink) return
    /* eslint-disable react-hooks/set-state-in-effect -- the OS delivers the link,
       not a React event, and App clears it once handled, so this runs once. */
    if (deepLink.unknownLibrary) {
      setNotice({ text: 'This link points at a library that is not on this server.', alert: true })
    } else {
      setFileScope('browse')
      setMode('collection')
      if (deepLink.kind === 'bundle') {
        setSelection({ view: 'all', collectionId: null })
        onSelect(deepLink.id)
        setLocateFile(null)
        setLocateRequest((value) => value + 1)
      } else {
        setSelection({ view: 'all', collectionId: deepLink.id })
      }
      setFilters(emptyAdHocFilters())
    }
    /* eslint-enable react-hooks/set-state-in-effect */
    onDeepLinkHandled?.()
  }, [deepLink, onDeepLinkHandled, onSelect])
  const libraryName = props.libraries.find((item) => item.id === props.library)?.name ?? 'Library'
  const tasks = useSourceTasks(props.library, setNotice, status?.source_original === true)
  // Write mode in Libraries is the one switch; each action below is its own operation
  const writeMode = useWriteMode(props.library, sourceEnabled)
  const writable = sourceEnabled && writeMode.data?.effective === true
  const trash = useTrash(props.library, sourceEnabled, mode === 'file' && fileScope === 'trash')
  const unfinished = useUnfinishedOperations(props.library, sourceEnabled, tasks)
  const rename = writable
    ? async (path: string, newName: string) => {
        const name = newName.trim()
        if (!name || name === path.split('/').at(-1)) return
        const error = renameError(name)
        if (error) throw new Error(error)
        await tasks.name(renameTask(path, name))
      }
    : undefined
  const sourceAction = writable
    ? (kind: 'copy' | 'move' | 'trash', paths: string[]) => {
        if (paths.length > 0) setAction({ kind, paths })
      }
    : undefined
  // Incoming files follow the active folder or open bundle; the collection
  // view creates a new bundle only when no bundle is open.
  const receive = (files: File[]) => {
    const remembered = lastFolders[props.library] ?? ''
    setIncoming({
      files,
      target:
        mode === 'file' && fileScope === 'browse'
          ? { kind: 'folder', folder: path }
          : mode === 'collection' && manualBundling
            ? dropContext.current.bundle
              ? {
                  kind: 'bundle',
                  bundle: dropContext.current.bundle.id,
                  title: dropContext.current.bundle.title,
                  folder: remembered,
                }
              : {
                  kind: 'new-bundle',
                  collection: dropContext.current.collection,
                  home: dropContext.current.home,
                  folder: remembered,
                }
            : { kind: 'folder', folder: remembered },
    })
  }
  const incomingDrop = useIncomingFileDrop(sourceEnabled, receive, (text) =>
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
              setFileScope('browse')
            }}
            systemViewsEnabled={props.systemViewsEnabled}
            fileScope={fileScope}
            onUnbundled={() => {
              setFileScope('unbundled')
              setMode('file')
            }}
            // Shown while write mode is on, or while the Trash holds anything:
            // turning write mode off must not make trashed files look gone
            showTrash={writable || trash.rows.length > 0}
            onTrash={() => {
              setFileScope('trash')
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
            activity={<>{props.libraryNotices?.(setNotice)}</>}
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
                    ? [{ label: 'Add Files…', onClick: () => filePicker.current?.click() }, null]
                    : []),
                  ...props.libraryMenu,
                ]}
              />
            }
            onToggleSidebar={toggleSidebar}
          />
        )}
        <div className="catalog-ordinary-content">
          {(tasks.tasks.some((task) => !task.inline) || unfinished.length > 0) && (
            <div className="file-activity" aria-label="File activity">
              <SourceTaskProgress tasks={tasks} />
              <UnfinishedOperations
                library={props.library}
                operations={unfinished}
                enabled={writable}
                tasks={tasks}
              />
            </div>
          )}
          {sourceEnabled && (
            <input
              ref={filePicker}
              type="file"
              multiple
              hidden
              aria-label="Files to copy into the library"
              onChange={(event) => {
                const files = Array.from(event.target.files ?? [])
                event.target.value = ''
                if (files.length === 0) return
                const error = incomingFilesError(files)
                if (error) setNotice({ text: error, alert: true })
                else receive(files)
              }}
            />
          )}
          {action && action.kind !== 'trash' && (
            <RelocateDialog
              library={props.library}
              action={action.kind}
              paths={action.paths}
              onClose={() => setAction(null)}
              onStart={tasks.start}
            />
          )}
          {action?.kind === 'trash' && (
            <TrashDialog
              paths={action.paths}
              onClose={() => setAction(null)}
              onStart={tasks.start}
            />
          )}
          {incoming && (
            <IncomingDialog
              library={props.library}
              files={incoming.files}
              target={incoming.target}
              collections={collections.items}
              onManage={props.onManage}
              onClose={() => setIncoming(null)}
              onStart={(task, folder) => {
                tasks.start(task)
                setLastFolders((previous) => ({ ...previous, [props.library]: folder }))
                setIncoming(null)
              }}
            />
          )}
          <div hidden={mode !== 'collection'} className="catalog-bundle-surface">
            <CatalogBundleBrowser
              {...props}
              hostFiles={hostFiles}
              onHostPath={setBundleHostPath}
              onLocateFile={(relative) => navigateFiles(relative)}
              onRenameFile={rename}
              onSourceAction={sourceAction}
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
              onDropContext={onDropContext}
              onDropFilesOnBundle={
                sourceEnabled && manualBundling
                  ? (files, bundle) =>
                      setIncoming({
                        files,
                        target: {
                          kind: 'bundle',
                          bundle: bundle.id,
                          title: bundle.title,
                          folder: bundle.folder ?? lastFolders[props.library] ?? '',
                        },
                      })
                  : undefined
              }
              onRenameCollection={(id) => setRenameCollection({ id })}
              dragItem={dragItem}
              onDragItem={updateDragItem}
              bundleMovesEnabled={bundleMoves}
              onNotice={setNotice}
              headerLeading={headerLeading}
              headerTrailing={headerTrailing}
              onScreen={mode === 'collection'}
              locateRequest={locateRequest}
              locateFile={locateFile}
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
              onRename={rename}
              onSourceAction={sourceAction}
            />
          )}
          {mode === 'file' && fileScope === 'trash' && (
            <CatalogTrashBrowser
              library={props.library}
              trash={trash}
              tasks={tasks}
              writable={writable}
              headerLeading={headerLeading}
              headerTrailing={headerTrailing}
              onReviewEntity={props.onReviewEntity}
            />
          )}
          {mode === 'file' && fileScope === 'browse' && (
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
                onLocateBundle={locate}
                onRename={rename}
                onSourceAction={sourceAction}
                onNewFolder={
                  writable && status?.source_mkdir
                    ? (parent, name) => tasks.name(newFolderTask(parent, name))
                    : undefined
                }
              />
              <aside className="inspector" aria-label="File inspector">
                {file ? (
                  <>
                    <CatalogFileDetails
                      key={file.relative_path}
                      library={props.library}
                      file={props.inspectorEnabled ? (file.file_id ?? null) : null}
                      entry={file}
                      hostFiles={hostFiles}
                      onLocate={() => {
                        if (file.bundle_id && !file.unbundled)
                          locate(
                            file.bundle_id,
                            file.file_id ? { id: file.file_id, path: file.relative_path } : null,
                          )
                      }}
                      locatable={Boolean(file.bundle_id && !file.unbundled)}
                      onRename={rename}
                    />
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
            setFileScope('browse')
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

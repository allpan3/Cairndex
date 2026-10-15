import { useCallback, useEffect, useState } from 'react'
import { CatalogQueryContext } from '../api/catalogQuery'
import type { FileBrowserEntry, LibraryRead } from '../api/client'
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
  /** The workspace's viewer is open and shows the bundle inspector itself. */
  viewerOpen?: boolean
  /** A `cairndex://` link to open; reported handled once applied. */
  deepLink?: PendingDeepLink | null
  onDeepLinkHandled?: () => void
}) {
  const [mode, setMode] = useState<AppMode>('collection')
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
  const [dropError, setDropError] = useState('')
  const [linkError, setLinkError] = useState('')
  // A card drag's payload, for the sidebar's drop highlights; dnd.ts holds the live copy
  const [dragItem, setDragItem] = useState<DragItem | null>(null)
  const [newCollection, setNewCollection] = useState<{ parentId: string | null } | null>(null)
  const [folder, setFolder] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const updateDragItem = useCallback((item: DragItem | null) => {
    setActiveDrag(item)
    setDragItem(item)
  }, [])
  // The drop reads Option/Alt (add, do not move) from whichever signal the engine delivers
  useEffect(() => installDragCopyTracking(document, hostAltKeyHeld), [])
  const status = useReplicaStatus(props.library).data
  const bundleMoves = (status?.selection_version ?? 0) >= 2 && !props.blocked
  const folderCollections = (status?.browse_version ?? 0) >= 7 && !props.blocked
  const { deepLink, onDeepLinkHandled, onSelect } = props
  // A bundle link selects and locates the bundle; a collection link opens the collection
  useEffect(() => {
    if (!deepLink) return
    /* eslint-disable react-hooks/set-state-in-effect -- the OS delivers the link,
       not a React event, and App clears it once handled, so this runs once. */
    if (deepLink.unknownLibrary) {
      setLinkError('This link points at a library that is not on this server.')
    } else {
      setLinkError('')
      setUnbundled(false)
      setMode('collection')
      if (deepLink.kind === 'bundle') {
        setSelection({ view: 'all', collectionId: null })
        onSelect(deepLink.id)
        setLocateRequest((value) => value + 1)
      } else {
        setSelection({ view: 'all', collectionId: deepLink.id })
      }
    }
    /* eslint-enable react-hooks/set-state-in-effect */
    onDeepLinkHandled?.()
  }, [deepLink, onDeepLinkHandled, onSelect])
  const sourceEnabled = Boolean(props.sourceOperationsEnabled && !props.blocked)
  const incomingDrop = useIncomingFileDrop(sourceEnabled, setIncoming, setDropError)
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
      <div className="catalog-ordinary-layout" {...incomingDrop}>
        <CatalogNavigation
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
          onSelect={(next) => {
            setUnbundled(false)
            setSelection(next)
            setMode('collection')
          }}
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
        />
        <div className="catalog-ordinary-content">
          {dropError && (
            <p role="alert">
              {dropError} <button onClick={() => setDropError('')}>Dismiss</button>
            </p>
          )}
          {notice && (
            <p role="status">
              {notice} <button onClick={() => setNotice('')}>Dismiss</button>
            </p>
          )}
          {linkError && (
            <p role="alert">
              {linkError} <button onClick={() => setLinkError('')}>Dismiss</button>
            </p>
          )}
          {sourceEnabled && (
            <SourceOperations
              library={props.library}
              editor={props.editor}
              file={mode === 'file' && !unbundled ? file : null}
              directory={mode === 'file' && !unbundled ? path : ''}
              onReviewEntity={props.onReviewEntity}
              incoming={incoming}
              onDismissIncoming={() => setIncoming(null)}
            />
          )}
          {hostFiles.error && (
            <p role="alert">
              {hostFiles.error}{' '}
              <button className="btn" onClick={hostFiles.dismissError}>
                Dismiss
              </button>
            </p>
          )}
          <div hidden={mode !== 'collection'} className="catalog-bundle-surface">
            <CatalogBundleBrowser
              {...props}
              hostFiles={hostFiles}
              onHostPath={setBundleHostPath}
              onLocateFile={(relative) => {
                setPath(relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '')
                setFile(null)
                setLocated(relative)
                setUnbundled(false)
                setMode('file')
              }}
              onBundleDrag={
                bundleMoves ? (ids) => updateDragItem(ids && { kind: 'bundles', ids }) : undefined
              }
              onNewCollection={(parentId) => setNewCollection({ parentId })}
              locateRequest={locateRequest}
              selection={selection}
              filters={filters}
              onFilters={setFilters}
            />
          </div>
          {mode === 'tags' && (
            <TagNavigation
              onSelect={(id) => {
                setFilters({
                  ...emptyAdHocFilters(),
                  tags: { ...emptyAdHocFilters().tags, include: [id] },
                })
                setSelection({ view: 'all', collectionId: null })
                setMode('collection')
              }}
            />
          )}
          {mode === 'file' && unbundled && (
            <CatalogUnbundledBrowser
              library={props.library}
              onReview={props.onReview}
              hostFiles={hostFiles}
              onHostPath={setUnbundledHostPath}
            />
          )}
          {mode === 'file' && !unbundled && (
            <div className="catalog-file-surface">
              <FileBrowser
                catalogLibrary={props.library}
                libraryName={
                  props.libraries.find((item) => item.id === props.library)?.name ?? 'Library'
                }
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
                onAddToBundle={props.onReview}
                onCreateBundle={props.onReview}
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
                    {!file.linked && <p>This file must be cataloged before it can open here.</p>}
                  </>
                ) : (
                  <p>Select a file to see its details.</p>
                )}
              </aside>
            </div>
          )}
        </div>
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
            setNotice(
              added === 1
                ? `Created “${collection.name}” with 1 bundle.`
                : `Created “${collection.name}” with ${added} bundles.`,
            )
          }}
        />
      )}
    </CatalogQueryContext>
  )
}

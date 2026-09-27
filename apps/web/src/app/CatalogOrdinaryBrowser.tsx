import { useState } from 'react'
import { CatalogQueryContext } from '../api/catalogQuery'
import type { FileBrowserEntry, LibraryRead } from '../api/client'
import { useTags } from '../api/hooks'
import { getHostLabels } from '../platform'
import { CatalogBundleBrowser } from './CatalogBundleBrowser'
import { CatalogNavigation } from './CatalogNavigation'
import { FileBrowser } from './FileBrowser'
import { emptyAdHocFilters } from './adHocFilters'
import { DEFAULT_PLAYER_PREFS, type AppMode, type Selection } from './types'
import { visibleHierarchy } from './usePopover'
import { CatalogUnbundledBrowser } from './CatalogUnbundledBrowser'
import { CatalogFileDetails } from './CatalogFileDetails'

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

export function CatalogOrdinaryBrowser(props: {
  library: string
  libraries: LibraryRead[]
  editor: string
  selectionEnabled: boolean
  systemViewsEnabled: boolean
  inspectorEnabled: boolean
  blocked: boolean
  selected: string | null
  onSelect: (id: string) => void
  onReviewEntity: (family: string, id: string) => void
  onReview: () => void
  onOpen: (id: string) => void
  onOpenFile: (bundle: string, file: string) => void
  onChangeLibrary: (id: string) => void
  onManage: () => void
}) {
  const [mode, setMode] = useState<AppMode>('collection')
  const [selection, setSelection] = useState<Selection>({ view: 'all', collectionId: null })
  const [filters, setFilters] = useState(emptyAdHocFilters)
  const [locateRequest, setLocateRequest] = useState(0)
  const [unbundled, setUnbundled] = useState(false)
  const [path, setPath] = useState('')
  const [file, setFile] = useState<FileBrowserEntry | null>(null)
  const [player, setPlayer] = useState(DEFAULT_PLAYER_PREFS)
  return (
    <CatalogQueryContext value={props.library}>
      <div className="catalog-ordinary-layout">
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
          onReview={props.onReview}
          onReviewEntity={props.onReviewEntity}
        />
        <div className="catalog-ordinary-content">
          <div hidden={mode !== 'collection'} className="catalog-bundle-surface">
            <CatalogBundleBrowser
              {...props}
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
            <CatalogUnbundledBrowser library={props.library} onReview={props.onReview} />
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
                selectedPath={file?.relative_path ?? null}
                onNavigate={(next) => {
                  setPath(next)
                  setFile(null)
                }}
                onSelectEntry={setFile}
                onAddToBundle={props.onReview}
                onCreateBundle={props.onReview}
                hostLabels={getHostLabels()}
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
    </CatalogQueryContext>
  )
}

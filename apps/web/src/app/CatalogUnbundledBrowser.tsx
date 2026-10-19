import { type ReactNode, useEffect, useState } from 'react'
import type { FileBrowserEntry } from '../api/client'
import { getHostLabels } from '../platform'
import type { LibraryHostFiles } from '../desktop/useLibraryHostFiles'
import { CatalogFileDetails } from './CatalogFileDetails'
import type { CatalogNotice } from './CatalogToast'
import { FileBrowser } from './FileBrowser'
import { AddToBundleDialog, CreateBundleDialog } from './ManualBundlingDialogs'
import { DEFAULT_PLAYER_PREFS } from './types'
import { useReplicaStatus } from '../api/useReplicaStatus'
import { FileInspector } from './FileInspector'
import { factsFromEntry } from './fileFacts'

/** The Unbundled queue, in the File Browser's own listing as v0.2.1 showed it. */
export function CatalogUnbundledBrowser({
  library,
  libraryName,
  onReview,
  onNotice,
  hostFiles,
  onHostPath,
  headerLeading,
  headerTrailing,
  bundling = false,
}: {
  library: string
  libraryName: string
  onReview: () => void
  onNotice: (notice: CatalogNotice) => void
  hostFiles?: LibraryHostFiles
  onHostPath?: (path: string | null) => void
  headerLeading?: ReactNode
  headerTrailing?: ReactNode
  /** Offer Create Bundle and Add to Bundle; the server needs `browse_version: 9`. */
  bundling?: boolean
}) {
  const [file, setFile] = useState<FileBrowserEntry | null>(null)
  const [dialog, setDialog] = useState<{
    kind: 'create' | 'add'
    ids: string[]
    paths: string[]
  } | null>(null)
  const pathBundling = (useReplicaStatus(library).data?.browse_version ?? 0) >= 15
  const [player, setPlayer] = useState(DEFAULT_PLAYER_PREFS)
  const path = file?.kind === 'file' ? file.relative_path : null
  useEffect(() => {
    onHostPath?.(path)
  }, [path, onHostPath])
  const ask = (kind: 'create' | 'add') => (paths: string[], ids: string[]) => {
    if (!bundling || (paths.length > 0 && !pathBundling)) onReview()
    else if (ids.length + paths.length > 0) setDialog({ kind, ids, paths })
  }
  const applied = (message: string) => {
    setDialog(null)
    setFile(null)
    onNotice({ text: message })
  }
  return (
    <div className="catalog-file-surface">
      <FileBrowser
        catalogLibrary={library}
        catalogPathBundling={pathBundling}
        libraryName={libraryName}
        scope="unbundled"
        path=""
        selectedPath={file?.relative_path ?? null}
        onNavigate={() => undefined}
        onSelectEntry={setFile}
        onCreateBundle={ask('create')}
        onAddToBundle={ask('add')}
        headerLeading={headerLeading}
        headerTrailing={headerTrailing}
        hostLabels={getHostLabels()}
        onRevealFile={hostFiles?.onRevealFile}
        onOpenFile={hostFiles?.onOpenFile}
        onStartFileDrag={hostFiles?.onStartFileDrag}
        onFlash={(text) => onNotice({ text })}
        playerPrefs={player}
        onPlayerPrefs={setPlayer}
      />
      {file?.file_id ? (
        <aside className="inspector" aria-label="File inspector">
          <CatalogFileDetails
            key={file.file_id}
            library={library}
            file={file.file_id}
            hostFiles={hostFiles}
          />
        </aside>
      ) : (
        <FileInspector
          entry={file ? factsFromEntry(file) : null}
          hostLabels={getHostLabels()}
          onRevealFile={hostFiles?.onRevealFile}
          onOpenFile={hostFiles?.onOpenFile}
          onStartFileDrag={hostFiles?.onStartFileDrag}
        />
      )}
      {dialog?.kind === 'create' && (
        <CreateBundleDialog
          selection={{ fileIds: dialog.ids, relativePaths: dialog.paths }}
          onClose={() => setDialog(null)}
          onApplied={applied}
        />
      )}
      {dialog?.kind === 'add' && (
        <AddToBundleDialog
          selection={{ fileIds: dialog.ids, relativePaths: dialog.paths }}
          onClose={() => setDialog(null)}
          onApplied={applied}
        />
      )}
    </div>
  )
}

import { type ReactNode, useEffect, useState } from 'react'
import type { FileBrowserEntry } from '../api/client'
import { getHostLabels } from '../platform'
import type { LibraryHostFiles } from '../desktop/useLibraryHostFiles'
import { CatalogFileDetails } from './CatalogFileDetails'
import type { CatalogNotice } from './CatalogToast'
import { FileBrowser } from './FileBrowser'
import { AddToBundleDialog, CreateBundleDialog } from './ManualBundlingDialogs'
import { DEFAULT_PLAYER_PREFS } from './types'

/** The Unbundled queue, in the File Browser's own listing as v0.2.1 showed it. */
export function CatalogUnbundledBrowser({
  library,
  libraryName,
  onReview,
  onNotice,
  hostFiles,
  onHostPath,
  headerLeading,
  bundling = false,
}: {
  library: string
  libraryName: string
  onReview: () => void
  onNotice: (notice: CatalogNotice) => void
  hostFiles?: LibraryHostFiles
  onHostPath?: (path: string | null) => void
  headerLeading?: ReactNode
  /** Offer Create Bundle and Add to Bundle; the server needs `browse_version: 9`. */
  bundling?: boolean
}) {
  const [file, setFile] = useState<FileBrowserEntry | null>(null)
  const [dialog, setDialog] = useState<{ kind: 'create' | 'add'; ids: string[] } | null>(null)
  const [player, setPlayer] = useState(DEFAULT_PLAYER_PREFS)
  const path = file?.kind === 'file' ? file.relative_path : null
  useEffect(() => {
    onHostPath?.(path)
  }, [path, onHostPath])
  const ask = (kind: 'create' | 'add') => (_paths: string[], ids: string[]) => {
    if (!bundling) onReview()
    else if (ids.length > 0) setDialog({ kind, ids })
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
        libraryName={libraryName}
        scope="unbundled"
        path=""
        selectedPath={file?.relative_path ?? null}
        onNavigate={() => undefined}
        onSelectEntry={setFile}
        onCreateBundle={ask('create')}
        onAddToBundle={ask('add')}
        headerLeading={headerLeading}
        hostLabels={getHostLabels()}
        onRevealFile={hostFiles?.onRevealFile}
        onOpenFile={hostFiles?.onOpenFile}
        onStartFileDrag={hostFiles?.onStartFileDrag}
        onFlash={(text) => onNotice({ text })}
        playerPrefs={player}
        onPlayerPrefs={setPlayer}
      />
      <aside className="inspector" aria-label="File inspector">
        {file?.file_id ? (
          <CatalogFileDetails
            key={file.file_id}
            library={library}
            file={file.file_id}
            hostFiles={hostFiles}
          />
        ) : (
          <div className="state">Select a file to see its details.</div>
        )}
      </aside>
      {dialog?.kind === 'create' && (
        <CreateBundleDialog
          selection={{ fileIds: dialog.ids }}
          onClose={() => setDialog(null)}
          onApplied={applied}
        />
      )}
      {dialog?.kind === 'add' && (
        <AddToBundleDialog
          selection={{ fileIds: dialog.ids }}
          onClose={() => setDialog(null)}
          onApplied={applied}
        />
      )}
    </div>
  )
}

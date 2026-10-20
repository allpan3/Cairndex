import type { ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { catalog, type Entity } from '../api/catalog'
import type { LibraryHostFiles } from '../desktop/useLibraryHostFiles'
import { CatalogBundleInspector } from './CatalogBundleInspector'

/**
 * The portable bundle inspector in the viewer's rail.
 *
 * The browser unmounts its own inspector while the viewer is open, so this one
 * is the only owner of the bundle's private drafts. Both read the stored draft
 * when they mount, so an edit made on one surface is there on the other.
 */
export function CatalogViewerInspector({
  library,
  bundle,
  editor,
  inspectorEnabled,
  blocked,
  onReview,
  moments,
  onOpenFile,
  hostFiles,
  onFilterTag,
  onLocateFile,
  onOpenDirectory,
}: {
  library: string
  bundle: string
  editor: string
  inspectorEnabled: boolean
  blocked: boolean
  onReview: () => void
  /** The moments section, with the viewer's moment source and player actions. */
  moments: ReactNode
  /** Show another file of this bundle in the viewer. */
  onOpenFile: (file: string) => void
  hostFiles?: LibraryHostFiles
  onFilterTag?: (id: string) => void
  onLocateFile?: (path: string) => void
  onOpenDirectory?: (path: string) => void
}) {
  const queryClient = useQueryClient()
  const detail = useQuery({
    queryKey: ['catalog-detail', library, 'asset_bundles', bundle],
    queryFn: () => catalog<Entity>(library, `/entities/asset_bundles/${bundle}`),
    refetchInterval: 2000,
  })
  if (!detail.data || detail.data.fields.$alive?.value !== 'true')
    return (
      <aside className="inspector" aria-label="Bundle inspector">
        <p>{detail.error ? 'Bundle details are unavailable.' : 'Waiting for bundle details.'}</p>
        {detail.error && <button onClick={() => void detail.refetch()}>Retry details</button>}
      </aside>
    )
  return (
    <CatalogBundleInspector
      library={library}
      entity={detail.data}
      editor={editor}
      inspectorEnabled={inspectorEnabled}
      blocked={blocked}
      // The browser under the viewer shows the saved title and cover when it returns
      refresh={() => {
        void detail.refetch()
        void queryClient.invalidateQueries({ queryKey: ['catalog-browse', library] })
      }}
      onReview={onReview}
      onOpenFile={onOpenFile}
      hostFiles={hostFiles}
      onFilterTag={onFilterTag}
      onLocateFile={onLocateFile}
      onOpenDirectory={onOpenDirectory}
      moments={moments}
    />
  )
}

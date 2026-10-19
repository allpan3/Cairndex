import type { ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { catalog, type Entity } from '../api/catalog'
import { CatalogQueryContext } from '../api/catalogQuery'
import type { components } from '../api/schema'
import { useReplicaStatus } from '../api/useReplicaStatus'
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
  onOpenCollection,
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
  onOpenCollection?: (id: string) => void
}) {
  const queryClient = useQueryClient()
  const status = useReplicaStatus(library).data
  const summary = useQuery({
    queryKey: ['catalog-bundle-summary', library, bundle],
    queryFn: () =>
      catalog<components['schemas']['CatalogBundleSummary']>(library, `/bundles/${bundle}/summary`),
    enabled: status?.bundle_summary_version === 1,
    refetchInterval: 2000,
  })
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
    <CatalogQueryContext value={library}>
      <CatalogBundleInspector
        library={library}
        entity={detail.data}
        editor={editor}
        inspectorEnabled={inspectorEnabled}
        blocked={blocked}
        // The browser under the viewer shows the saved title and cover when it returns
        refresh={() => {
          void detail.refetch()
          if (status?.bundle_summary_version === 1) void summary.refetch()
          void queryClient.invalidateQueries({ queryKey: ['catalog-browse', library] })
        }}
        onReview={onReview}
        onOpenFile={onOpenFile}
        hostFiles={hostFiles}
        onFilterTag={onFilterTag}
        onLocateFile={onLocateFile}
        onOpenDirectory={onOpenDirectory}
        onOpenCollection={onOpenCollection}
        summary={summary.data && { ...summary.data, size_known: summary.data.total_size != null }}
        moments={moments}
      />
    </CatalogQueryContext>
  )
}

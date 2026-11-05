import { keepPreviousData, useQuery } from '@tanstack/react-query'
import type { FileBrowserEntry } from '../api/client'
import type { components } from '../api/schema'
import { replicaRequest } from '../api/replicas'
import { getHostLabels } from '../platform'
import { FileInspector } from './FileInspector'
import { factsFromBundleFile, factsFromEntry, type FileFacts } from './fileFacts'
import type { LibraryHostFiles } from '../desktop/useLibraryHostFiles'

const UNAVAILABLE = 'Unavailable on this device'

// Only an explicitly selected file requests a bounded local observation. A File
// Browser entry describes the file until then, and an unindexed one has no file id.
// Each selection reads the file again, and so does a change in the polled listing's
// state for it. The toolbar's Refresh (RefreshButton) and a finished Update
// (useReplicaDiscovery) mark every observation stale, so no file needs a check of its own.
export function CatalogFileDetails({
  library,
  file,
  entry,
  hostFiles,
  onLocate,
  locatable = true,
}: {
  library: string
  file: string | null
  entry?: FileBrowserEntry
  hostFiles?: LibraryHostFiles
  onLocate?: () => void
  /** False greys Locate out: the file is not in a bundle the browser shows */
  locatable?: boolean
}) {
  const detail = useQuery({
    queryKey: ['catalog-local-file', library, file, entry?.local_state],
    queryFn: () =>
      replicaRequest<components['schemas']['LocalMediaRead']>(library, `/media/files/${file}`),
    enabled: file !== null,
    staleTime: 0,
    // The last observation stays on screen while the listing's new state is read
    placeholderData: keepPreviousData,
    retry: false,
    refetchOnWindowFocus: false,
  })
  const listed = entry ? factsFromEntry(entry) : null
  let facts: FileFacts | null = detail.data ? factsFromBundleFile(detail.data.file) : listed
  if (detail.data && facts) {
    const available = detail.data.state === 'available'
    // The listing keeps the modified time and bundle status the observation lacks
    facts = listed
      ? { ...facts, modifiedAt: listed.modifiedAt, status: available ? listed.status : UNAVAILABLE }
      : { ...facts, status: available ? 'Observed on this device' : UNAVAILABLE }
  }
  // The polled listing is the live signal after a file disappears
  if (facts && entry?.local_state === 'unavailable') facts = { ...facts, status: UNAVAILABLE }
  else if (facts && !detail.data && entry?.local_state === 'unknown')
    facts = { ...facts, status: 'Unknown on this device' }
  return (
    <section aria-label="Local file details" className="catalog-file-details">
      {detail.isPending && !facts && file !== null && (
        <p role="status">Checking this file on this device…</p>
      )}
      {detail.error && <p role="alert">{detail.error.message}</p>}
      {detail.data?.message && <p role="status">{detail.data.message}</p>}
      {facts && (
        <FileInspector
          entry={facts}
          hostLabels={getHostLabels()}
          onRevealFile={hostFiles?.onRevealFile}
          onOpenFile={hostFiles?.onOpenFile}
          onStartFileDrag={hostFiles?.onStartFileDrag}
          locateLabel="Locate in Bundle Browser"
          onLocate={onLocate && (() => onLocate())}
          locateDisabled={!locatable}
        />
      )}
    </section>
  )
}

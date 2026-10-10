import { useQuery } from '@tanstack/react-query'
import type { components } from '../api/schema'
import { replicaRequest } from '../api/replicas'
import { getHostLabels } from '../platform'
import { FileInspector } from './FileInspector'
import { factsFromBundleFile } from './fileFacts'

// Only an explicitly selected file requests a bounded local observation.
export function CatalogFileDetails({ library, file }: { library: string; file: string }) {
  const detail = useQuery({
    queryKey: ['catalog-local-file', library, file],
    queryFn: () =>
      replicaRequest<components['schemas']['LocalMediaRead']>(library, `/media/files/${file}`),
    retry: false,
    refetchOnWindowFocus: false,
  })
  const facts = detail.data ? factsFromBundleFile(detail.data.file) : null
  if (facts)
    facts.status =
      detail.data!.state === 'available' ? 'Observed on this device' : 'Unavailable on this device'
  return (
    <section aria-label="Local file details" className="catalog-file-details">
      {detail.isPending && <p role="status">Checking this file on this device…</p>}
      {detail.error && <p role="alert">{detail.error.message}</p>}
      {detail.data?.message && <p role="status">{detail.data.message}</p>}
      {facts && <FileInspector entry={facts} hostLabels={getHostLabels()} />}
      <button disabled={detail.isFetching} onClick={() => void detail.refetch()}>
        Retry local file details
      </button>
      <p>These observations apply to this device. Opening media checks the file again.</p>
    </section>
  )
}

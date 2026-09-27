import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { catalog, type Entity } from '../api/catalog'
import { replicaRequest } from '../api/replicas'
import type { components } from '../api/schema'
import { InspectorSection } from './InspectorSection'
import { CatalogFileDetails } from './CatalogFileDetails'

export function CatalogBundleFiles({
  library,
  bundle,
  cover,
  blocked,
  onCover,
  onOpen,
}: {
  library: string
  bundle: string
  cover: string | null
  blocked: boolean
  onCover: (file: string | null, reference?: Entity) => void
  onOpen: (file: string) => void
}) {
  const [offset, setOffset] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const page = useQuery({
    queryKey: ['catalog-inspector-files', library, bundle, offset],
    queryFn: () =>
      replicaRequest<components['schemas']['ReplicaPlaylist']>(
        library,
        `/media/bundles/${bundle}?offset=${offset}&limit=30`,
      ),
    refetchInterval: 2000,
  })
  async function selectCover(id: string) {
    setBusy(true)
    setError('')
    try {
      const entity = await catalog<Entity>(library, `/entities/asset_files/${id}`)
      onCover(id, entity)
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <InspectorSection id="files" title="Files in bundle">
      <section aria-label="Files in bundle">
        <button disabled={blocked || busy || !cover} onClick={() => onCover(null)}>
          Use automatic cover
        </button>
        {page.isPending && <p>Loading files…</p>}
        {page.error && <button onClick={() => void page.refetch()}>Retry bundle files</button>}
        {page.data?.files.length === 0 && <p>No files in this page.</p>}
        {page.data?.files.map((file) => (
          <div key={file.id} className="catalog-inspector-file">
            <button aria-pressed={selected === file.id} onClick={() => setSelected(file.id)}>
              {file.relative_path}
            </button>
            {['image', 'video'].includes(file.media_kind) && (
              <div>
                <button onClick={() => onOpen(file.id)} aria-label={`Open ${file.relative_path}`}>
                  Open
                </button>
                <button
                  disabled={blocked || busy}
                  aria-pressed={cover === file.id}
                  aria-label={`Set ${file.relative_path} as cover`}
                  onClick={() => void selectCover(file.id)}
                >
                  {cover === file.id ? 'Selected cover' : 'Set as cover'}
                </button>
              </div>
            )}
          </div>
        ))}
        {offset > 0 && (
          <button onClick={() => setOffset(Math.max(0, offset - 30))}>Previous files</button>
        )}
        {page.data?.next_offset != null && (
          <button onClick={() => setOffset(page.data!.next_offset!)}>More files</button>
        )}
        {error && <p role="alert">{error}</p>}
        {selected && (
          <>
            <button onClick={() => setSelected(null)}>Close file details</button>
            <CatalogFileDetails key={selected} library={library} file={selected} />
          </>
        )}
      </section>
    </InspectorSection>
  )
}

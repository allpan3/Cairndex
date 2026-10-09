// Catalog File Browser stays beneath the active library root and uses indexed directory pages
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { catalog } from '../api/catalog'

// Catalog paths are metadata identities; browsing never probes or modifies physical media
export function CatalogFileBrowser({
  library,
  onOpen,
}: {
  library: string
  onOpen: (id: string) => void
}) {
  const [directory, setDirectory] = useState('')
  const [after, setAfter] = useState('')
  const page = useQuery({
    queryKey: ['catalog-files', library, directory, after],
    queryFn: () =>
      catalog<{
        items: { cursor: string; path: string; kind: string; entity: string }[]
        next_cursor: string | null
      }>(
        library,
        `/files?directory=${encodeURIComponent(directory)}&after=${encodeURIComponent(after)}`,
      ),
    refetchInterval: 2000,
  })
  function open(path: string) {
    setDirectory(path)
    setAfter('')
  }
  return (
    <section aria-label="Library File Browser">
      <h2>File Browser</h2>
      <p>{directory || 'Library root'}</p>
      <button onClick={() => open('')}>Library root</button>
      {directory && (
        <button onClick={() => open(directory.split('/').slice(0, -1).join('/'))}>
          Parent directory
        </button>
      )}
      {page.isPending && <p role="status">Loading catalog paths…</p>}
      {page.error && (
        <p role="alert">
          {page.error.message} {page.data ? 'Showing cached paths. ' : ''}
          <button disabled={page.isFetching} onClick={() => void page.refetch()}>
            Retry paths
          </button>
        </p>
      )}
      <ul>
        {page.data?.items.map((item) => (
          <li key={item.cursor}>
            <button
              onClick={() => (item.kind === 'directory' ? open(item.path) : onOpen(item.entity))}
            >
              {item.path.split('/').at(-1)}
              {item.kind === 'directory' ? '/' : ''}
            </button>
          </li>
        ))}
      </ul>
      {!page.error && page.data?.items.length === 0 && <p>No cataloged files in this directory.</p>}
      {page.data?.next_cursor && (
        <button onClick={() => setAfter(page.data!.next_cursor!)}>More paths</button>
      )}
    </section>
  )
}

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { catalog } from '../api/catalog'
import type { components } from '../api/schema'
import { CatalogFileDetails } from './CatalogFileDetails'

export function CatalogUnbundledBrowser({
  library,
  onReview,
}: {
  library: string
  onReview: () => void
}) {
  const [search, setSearch] = useState('')
  const [offset, setOffset] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  const page = useQuery({
    queryKey: ['catalog-unbundled', library, search, offset],
    queryFn: () =>
      catalog<components['schemas']['CatalogUnbundledPage']>(library, '/files/unbundled', 'POST', {
        q: search,
        offset,
        limit: 50,
      }),
    refetchInterval: 2000,
  })
  return (
    <div className="catalog-file-surface">
      <section className="catalog-unbundled" aria-label="Unbundled files">
        <h2>Unbundled</h2>
        <p>
          Cataloged files awaiting bundle confirmation. New Update suggestions remain in grouping
          review until accepted.
        </p>
        <label>
          Search files
          <input
            type="search"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value)
              setOffset(0)
              setSelected(null)
            }}
          />
        </label>
        <button onClick={onReview}>Review grouping and metadata</button>
        {page.isPending && <p>Loading files…</p>}
        {page.error && <button onClick={() => void page.refetch()}>Retry unbundled files</button>}
        <ul>
          {page.data?.items.map((item) => (
            <li key={item.id}>
              <button aria-pressed={selected === item.id} onClick={() => setSelected(item.id)}>
                {item.relative_path}
              </button>
            </li>
          ))}
        </ul>
        {page.data?.total === 0 && <p>No unbundled files match this search.</p>}
        {page.data && <p>{page.data.total} files</p>}
        {offset > 0 && (
          <button
            onClick={() => {
              setOffset(Math.max(0, offset - 50))
              setSelected(null)
            }}
          >
            Previous files
          </button>
        )}
        {page.data && offset + page.data.items.length < page.data.total && (
          <button
            onClick={() => {
              setOffset(offset + 50)
              setSelected(null)
            }}
          >
            More files
          </button>
        )}
      </section>
      <aside className="inspector" aria-label="Unbundled file inspector">
        {selected ? (
          <CatalogFileDetails key={selected} library={library} file={selected} />
        ) : (
          <p>Select a file to see its details.</p>
        )}
      </aside>
    </div>
  )
}

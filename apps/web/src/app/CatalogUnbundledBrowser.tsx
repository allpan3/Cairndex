import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { catalog } from '../api/catalog'
import type { components } from '../api/schema'
import { CatalogFileDetails } from './CatalogFileDetails'
import { AddToBundleDialog, CreateBundleDialog } from './ManualBundlingDialogs'
import type { LibraryHostFiles } from '../desktop/useLibraryHostFiles'

export function CatalogUnbundledBrowser({
  library,
  onReview,
  hostFiles,
  onHostPath,
  bundling = false,
}: {
  library: string
  onReview: () => void
  hostFiles?: LibraryHostFiles
  onHostPath?: (path: string | null) => void
  /** Offer Create Bundle and Add to Bundle; the server needs `browse_version: 9`. */
  bundling?: boolean
}) {
  const [search, setSearch] = useState('')
  const [offset, setOffset] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  // The files the bundling actions take; Cmd/Ctrl-click adds or removes one
  const [chosen, setChosen] = useState<string[]>([])
  const [dialog, setDialog] = useState<'create' | 'add' | null>(null)
  const [notice, setNotice] = useState('')
  const reset = () => {
    setSelected(null)
    setChosen([])
  }
  const applied = (message: string) => {
    setNotice(message)
    setDialog(null)
    reset()
  }
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
  const path = page.data?.items.find((item) => item.id === selected)?.relative_path ?? null
  useEffect(() => {
    onHostPath?.(path)
  }, [path, onHostPath])
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
              reset()
            }}
          />
        </label>
        <button onClick={onReview}>Review grouping and metadata</button>
        {bundling && (
          <div className="catalog-unbundled__actions">
            <span>{chosen.length} selected</span>
            <button disabled={chosen.length === 0} onClick={() => setDialog('create')}>
              Create Bundle…
            </button>
            <button disabled={chosen.length === 0} onClick={() => setDialog('add')}>
              Add to Bundle…
            </button>
          </div>
        )}
        {notice && <p role="status">{notice}</p>}
        {page.isPending && <p>Loading files…</p>}
        {page.error && <button onClick={() => void page.refetch()}>Retry unbundled files</button>}
        <ul>
          {page.data?.items.map((item) => (
            <li key={item.id}>
              <button
                aria-pressed={chosen.includes(item.id)}
                onClick={(event) => {
                  setSelected(item.id)
                  setChosen((prior) =>
                    !(event.metaKey || event.ctrlKey)
                      ? [item.id]
                      : prior.includes(item.id)
                        ? prior.filter((id) => id !== item.id)
                        : [...prior, item.id],
                  )
                }}
              >
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
              reset()
            }}
          >
            Previous files
          </button>
        )}
        {page.data && offset + page.data.items.length < page.data.total && (
          <button
            onClick={() => {
              setOffset(offset + 50)
              reset()
            }}
          >
            More files
          </button>
        )}
      </section>
      <aside className="inspector" aria-label="Unbundled file inspector">
        {selected ? (
          <CatalogFileDetails
            key={selected}
            library={library}
            file={selected}
            hostFiles={hostFiles}
          />
        ) : (
          <p>Select a file to see its details.</p>
        )}
      </aside>
      {dialog === 'create' && (
        <CreateBundleDialog
          selection={{ fileIds: chosen }}
          onClose={() => setDialog(null)}
          onApplied={applied}
        />
      )}
      {dialog === 'add' && (
        <AddToBundleDialog
          selection={{ fileIds: chosen }}
          onClose={() => setDialog(null)}
          onApplied={applied}
        />
      )}
    </div>
  )
}

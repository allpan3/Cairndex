import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { replicaRequest } from '../api/replicas'
import type { components } from '../api/schema'
import { folderLabel } from './sourceTasks'

type Listing = components['schemas']['FileBrowserListingRead']

/**
 * Chooses one existing library folder: the chosen folder as a path you can
 * click back up, and, on request, its subfolders to go further down. Only
 * folders the server lists can be chosen, so the answer is always a real
 * in-library directory. `exclude` hides paths that cannot be the answer, such
 * as a folder being moved.
 */
export function FolderPicker({
  library,
  value,
  onChange,
  exclude = [],
  startOpen = false,
}: {
  library: string
  value: string
  onChange: (folder: string) => void
  exclude?: string[]
  startOpen?: boolean
}) {
  const [open, setOpen] = useState(startOpen)
  const listing = useQuery({
    queryKey: ['catalog-local-directory', library, value],
    queryFn: () =>
      replicaRequest<Listing>(library, `/media/directory?path=${encodeURIComponent(value)}`),
    enabled: open,
  })
  const parts = value ? value.split('/') : []
  const folders = (listing.data?.entries ?? []).filter(
    (entry) => entry.kind === 'directory' && !exclude.includes(entry.relative_path),
  )
  return (
    <div className="folder-picker">
      <div className="folder-picker__path" aria-label="Chosen folder">
        <button
          type="button"
          className="folder-picker__crumb"
          aria-current={parts.length === 0 ? 'location' : undefined}
          onClick={() => onChange('')}
        >
          Library
        </button>
        {parts.map((part, index) => (
          <span key={index}>
            <span className="folder-picker__sep">/</span>
            <button
              type="button"
              className="folder-picker__crumb"
              aria-current={index === parts.length - 1 ? 'location' : undefined}
              onClick={() => onChange(parts.slice(0, index + 1).join('/'))}
            >
              {part}
            </button>
          </span>
        ))}
        {!open && (
          <button type="button" className="btn btn--sm" onClick={() => setOpen(true)}>
            Change…
          </button>
        )}
      </div>
      {open && (
        <ul className="folder-picker__list" aria-label={`Folders in ${folderLabel(value)}`}>
          {listing.isPending && <li className="modal__note">Loading folders…</li>}
          {listing.error && (
            <li role="alert">
              {listing.error.message}{' '}
              <button className="btn btn--sm" onClick={() => void listing.refetch()}>
                Retry
              </button>
            </li>
          )}
          {listing.data && folders.length === 0 && (
            <li className="modal__note">No folders inside {folderLabel(value)}.</li>
          )}
          {folders.map((entry) => (
            <li key={entry.relative_path}>
              <button
                type="button"
                className="folder-picker__folder"
                onClick={() => onChange(entry.relative_path)}
              >
                {entry.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

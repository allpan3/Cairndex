import { fileDragProps } from './dragOut'
import type { LibraryHostFiles } from '../desktop/useLibraryHostFiles'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { catalog, type Entity } from '../api/catalog'
import { replicaRequest } from '../api/replicas'
import type { components } from '../api/schema'
import { formatBytes, formatDuration, formatFileRole, formatResolution } from '../lib/format'
import { collapsePrefixLengths } from './distinctNames'
import { IconPlay } from './icons'
import { InspectorSection } from './InspectorSection'
import { CatalogFileDetails } from './CatalogFileDetails'

const PAGE = 30

/**
 * The bundle's files as v0.2.1's inspector listed them: name, kind and size,
 * a ★ that makes a file the cover (and, when it already is, returns to the
 * automatic cover), and ▶ to open it. A row opens this device's details for
 * that file. The playlist carries no local observation, so no row claims a
 * file is missing; the details and the viewer check the file itself.
 */
export function CatalogBundleFiles({
  library,
  bundle,
  cover,
  blocked,
  fileCount,
  onCover,
  onOpen,
  onAddFiles,
  hostFiles,
  onSelectHostFile,
}: {
  hostFiles?: LibraryHostFiles
  onSelectHostFile?: (file: string | null) => void
  library: string
  bundle: string
  cover: string | null
  blocked: boolean
  /** The browser's count for the bundle, when it has one. */
  fileCount?: number
  onCover: (file: string | null, reference?: Entity) => void
  onOpen: (file: string) => void
  /** Add Unbundled files to this confirmed bundle. */
  onAddFiles?: () => void
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
        `/media/bundles/${bundle}?offset=${offset}&limit=${PAGE}`,
      ),
    refetchInterval: 2000,
  })
  const files = page.data?.files ?? []
  const cuts = collapsePrefixLengths(files.map((file) => file.display_title))
  async function toggleCover(id: string) {
    if (cover === id) {
      onCover(null)
      return
    }
    setBusy(true)
    setError('')
    try {
      // The cover's own liveness is part of the save, so read it first
      const entity = await catalog<Entity>(library, `/entities/asset_files/${id}`)
      onCover(id, entity)
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const pick = (id: string) => {
    const next = selected === id ? null : id
    setSelected(next)
    onSelectHostFile?.(next)
  }
  return (
    <InspectorSection
      id="files"
      className="files catalog-files"
      title={`Files in bundle${fileCount != null ? ` (${fileCount})` : ''}`}
      actions={
        onAddFiles && (
          <button
            className="sidebar__add"
            onClick={onAddFiles}
            title="Add unbundled files to this bundle"
            aria-label="Add files to this bundle"
          >
            +
          </button>
        )
      }
    >
      {page.isPending && <p className="catalog-files__status">Loading files…</p>}
      {page.error && (
        <p className="catalog-files__status" role="alert">
          Files are unavailable.{' '}
          <button className="btn btn--sm" onClick={() => void page.refetch()}>
            Try Again
          </button>
        </p>
      )}
      {page.data && files.length === 0 && (
        <p className="catalog-files__status">No files in this bundle.</p>
      )}
      <div className="files__list" role="list" aria-label="Files in bundle">
        {files.map((file, index) => {
          const meta = (file.tech_metadata ?? {}) as Record<string, unknown>
          const line = [
            formatFileRole(file.media_kind, file.original_filename),
            file.size_bytes ? formatBytes(file.size_bytes) : null,
            meta.width && meta.height
              ? formatResolution(meta.width as number, meta.height as number)
              : null,
            meta.duration ? formatDuration(meta.duration as number) : null,
          ]
            .filter(Boolean)
            .join(' · ')
          const visual = file.media_kind === 'image' || file.media_kind === 'video'
          const isCover = cover === file.id
          const cut = cuts[index] ?? 0
          return (
            <div
              key={file.id}
              className={`file-row${selected === file.id ? ' file-row--selected' : ''}`}
              role="listitem"
              {...fileDragProps(hostFiles?.onStartFileDrag, () => [file.relative_path])}
            >
              <button
                className="file-row__main"
                aria-pressed={selected === file.id}
                title={file.relative_path}
                onClick={() => pick(file.id)}
              >
                <span className="file-row__name">
                  {cut > 0 ? (
                    <span className="file-row__title file-row__title--split">
                      <span className="fname__shared">{file.display_title.slice(0, cut)}</span>
                      <span className="fname__distinct">{file.display_title.slice(cut)}</span>
                    </span>
                  ) : (
                    <span className="file-row__title">{file.display_title}</span>
                  )}
                </span>
                <span className="file-row__role">{line}</span>
              </button>
              <div className="file-row__actions">
                {visual && (
                  <button
                    className={`tip cover-action${isCover ? ' cover-action--active' : ''}`}
                    data-tip={
                      isCover ? 'Current cover · click to use the automatic cover' : 'Set as cover'
                    }
                    aria-label={`Set ${file.relative_path} as cover`}
                    aria-pressed={isCover}
                    disabled={blocked || busy}
                    onClick={() => void toggleCover(file.id)}
                  >
                    ★
                  </button>
                )}
                {visual && (
                  <button
                    className="tip play-file-action"
                    data-tip="Play this media"
                    aria-label={`Play ${file.relative_path}`}
                    onClick={() => onOpen(file.id)}
                  >
                    <IconPlay />
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
      {selected && files.some((file) => file.id === selected) && (
        <CatalogFileDetails
          key={selected}
          library={library}
          file={selected}
          hostFiles={hostFiles}
        />
      )}
      {(offset > 0 || page.data?.next_offset != null) && (
        <div className="catalog-files__pages">
          {offset > 0 && (
            <button className="btn btn--sm" onClick={() => setOffset(Math.max(0, offset - PAGE))}>
              Previous files
            </button>
          )}
          {page.data?.next_offset != null && (
            <button className="btn btn--sm" onClick={() => setOffset(page.data!.next_offset!)}>
              More files
            </button>
          )}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </InspectorSection>
  )
}

import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { replicaRequest } from '../api/replicas'
import type { components } from '../api/schema'
import { operationId } from '../api/catalog'
import { useWriteMode } from '../api/hooks'
import { formatBytes } from '../lib/format'
import { FolderPicker } from './FolderPicker'
import { folderListing, pickedFolder } from './folderListing'
import {
  type BundleHome,
  folderLabel,
  folderNameFor,
  joinPath,
  noun,
  parentFolder,
  suggestBundleTitle,
} from './sourceTasks'
import type { CatalogCollection } from './useCatalogCollections'
import { useModalDialog } from './useModalDialog'
import type { NewTask } from './useSourceTasks'

/**
 * What files from this computer become, decided by where they were dropped:
 * a new bundle (the Bundle Browser), more files of one bundle (a card or open album),
 * or plain files in a folder (the File Browser). Each target suggests a folder.
 */
export type IncomingTarget =
  | {
      kind: 'new-bundle'
      collection: string | null
      /** Where the dropped-on view's bundles are stored, when it shows any */
      home: BundleHome | null
      /** The last folder files went to, for a drop with no better hint */
      folder: string
    }
  | { kind: 'bundle'; bundle: string; title: string; folder: string }
  | { kind: 'folder'; folder: string }

/** The open Bundle Browser view, including a bundle whose contents are open. */
export type IncomingDropContext = {
  collection: string | null
  home: BundleHome | null
  bundle: { id: string; title: string } | null
}

function collectionNames(items: CatalogCollection[], id: string): string[] {
  const byId = new Map(items.map((item) => [item.id, item]))
  const names: string[] = []
  for (let item = byId.get(id); item && names.length < 32; item = byId.get(item.parent_id ?? ''))
    names.unshift(item.name)
  return names
}

const collectionPath = (items: CatalogCollection[], id: string) =>
  collectionNames(items, id).join(' / ')

/**
 * The folder a new bundle suggests before the owner chooses one. Its view's
 * bundles say where bundles are kept. A collection with none yet maps its
 * path onto folders of the same names. Without either, the last folder used.
 * A bundle gets a folder of its own when its neighbours have one each, or,
 * with no neighbours to follow, when it has more than one file.
 */
function newBundleFolder(
  target: Extract<IncomingTarget, { kind: 'new-bundle' }>,
  collections: CatalogCollection[],
  title: string,
  fileCount: number,
): string[] {
  const split = (folder: string) => (folder ? folder.split('/') : [])
  let base: string[], own: boolean
  if (target.home) [base, own] = [split(target.home.folder), target.home.perBundle]
  else if (target.collection)
    [base, own] = [collectionNames(collections, target.collection), fileCount > 1]
  else [base, own] = [split(target.folder), false]
  const name = own ? folderNameFor(title) : null
  return name ? [...base, name] : base
}

/**
 * Asks only what the drop could not say, then hands the copies to the
 * background task runner and closes: the bundle's name and collections, and
 * the folder that receives the files. The originals are never touched.
 */
export function IncomingDialog({
  library,
  files,
  target,
  collections,
  onManage,
  onClose,
  onStart,
}: {
  library: string
  files: File[]
  target: IncomingTarget
  collections: CatalogCollection[]
  onManage: () => void
  onClose: () => void
  onStart: (task: NewTask, folder: string) => void
}) {
  const writeMode = useWriteMode(library)
  const enabled = writeMode.data?.effective === true
  const queryClient = useQueryClient()
  const [choice, setChoice] = useState<{ folder: string; pending: string[] } | null>(null)
  const bundle = target.kind === 'bundle' ? target.bundle : null
  const suggestion = useQuery({
    queryKey: ['incoming-bundle-folder', library, bundle],
    enabled: bundle !== null,
    // One ordered member is enough for a default. Do not scan source storage or
    // load every file merely to suggest a destination for the owner's review.
    queryFn: async ({ signal }) => {
      const page = await replicaRequest<components['schemas']['CatalogAlbumPage']>(
        library,
        `/media/bundles/${bundle}/album?offset=0&limit=1`,
        'GET',
        undefined,
        signal,
      )
      const first = page.items[0]
      return first?.file
        ? parentFolder(first.file.relative_path)
        : (first?.directory?.directory_path ?? null)
    },
    gcTime: 0,
    retry: false,
  })
  const [title, setTitle] = useState(() => suggestBundleTitle(files))
  const candidate =
    target.kind === 'new-bundle' ? newBundleFolder(target, collections, title, files.length) : []
  // How much of the suggested path exists; the rest is created before the copy
  const existing = useQuery({
    queryKey: ['incoming-new-folder', library, candidate],
    enabled: target.kind === 'new-bundle' && choice === null,
    queryFn: async () => {
      let folder = ''
      for (const [index, name] of candidate.entries()) {
        const listing = await queryClient.fetchQuery({
          ...folderListing(library, folder),
          staleTime: 30_000,
        })
        const next = joinPath(folder, name)
        if (
          !listing.entries.some(
            (entry) => entry.kind === 'directory' && entry.relative_path === next,
          )
        )
          return index
        folder = next
      }
      return candidate.length
    },
    placeholderData: (previous) => previous,
    retry: false,
  })
  const suggested =
    target.kind === 'new-bundle' && existing.data !== undefined && !existing.isError
      ? {
          folder: candidate.slice(0, existing.data).join('/'),
          pending: candidate.slice(existing.data),
        }
      : null
  const picked = choice ?? suggested
  const folder = picked
    ? pickedFolder(picked.folder, picked.pending)
    : (suggestion.data ?? target.folder)
  const folderReady =
    choice !== null ||
    (target.kind === 'new-bundle'
      ? existing.isSuccess && !existing.isPlaceholderData
      : bundle === null || suggestion.isSuccess)
  const [chosen, setChosen] = useState<string[]>(() =>
    target.kind === 'new-bundle' && target.collection ? [target.collection] : [],
  )
  const { ref, close } = useModalDialog(onClose)
  const choices = useMemo(
    () =>
      collections
        .map((item) => ({ id: item.id, path: collectionPath(collections, item.id) }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    [collections],
  )
  const total = files.reduce((sum, file) => sum + file.size, 0)
  const count = noun(files.length)
  const heading =
    target.kind === 'new-bundle'
      ? `Add ${count} as a new bundle`
      : target.kind === 'bundle'
        ? `Add ${count} to “${target.title || 'Untitled bundle'}”`
        : `Copy ${count} to ${folderLabel(folder)}`

  function start() {
    const where = folderLabel(folder)
    // New folders are created first, outermost first; each needs its parent
    const created = (picked?.pending ?? []).map((name, index, names) => ({
      name,
      size: null,
      request: {
        operation: operationId(),
        action: 'mkdir' as const,
        destination: pickedFolder(picked!.folder, names.slice(0, index + 1)),
      },
    }))
    const copies = files.map((file) => ({
      name: file.name,
      size: file.size,
      file,
      request: {
        operation: operationId(),
        action: 'copy' as const,
        upload: operationId(),
        destination: joinPath(folder, file.name),
        collision: 'fail' as const,
      },
    }))
    const items = [...created, ...copies]
    const name = title.trim()
    onStart(
      target.kind === 'new-bundle'
        ? {
            title: `Copying ${count} for “${name || 'Untitled bundle'}”`,
            summary: `Copied ${count} to ${where}.`,
            finish: { kind: 'new-bundle', title: name, collections: chosen },
            items,
          }
        : target.kind === 'bundle'
          ? {
              title: `Adding ${count} to “${target.title || 'Untitled bundle'}”`,
              summary: `Copied ${count} to ${where}.`,
              finish: {
                kind: 'add-to-bundle',
                bundle: target.bundle,
                title: target.title || 'Untitled bundle',
              },
              items,
            }
          : {
              title: `Copying ${count} to ${where}`,
              summary: `Copied ${count} to ${where}.`,
              finish: { kind: 'none' },
              items,
            },
      folder,
    )
  }

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="incoming-title"
        className="modal incoming"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <form
          className="incoming__form"
          onSubmit={(event) => {
            event.preventDefault()
            if (enabled && folderReady) start()
          }}
        >
          <div className="modal__head">
            <h2 id="incoming-title">{heading}</h2>
          </div>
          <ul className="incoming__files" aria-label="Files to add">
            {files.map((file, index) => (
              <li key={index} className="incoming__file">
                <span className="incoming__name" title={file.name}>
                  {file.name}
                </span>
                <span className="incoming__size">{formatBytes(file.size)}</span>
              </li>
            ))}
          </ul>
          <p className="modal__note">
            {count} · {formatBytes(total)}. Cairndex copies them; the originals stay where they are.
          </p>
          {target.kind === 'new-bundle' && (
            <>
              <label className="incoming__field">
                <span>Bundle name</span>
                <input
                  className="edit"
                  value={title}
                  placeholder="Untitled bundle"
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
              <div className="incoming__field">
                <span id="incoming-collections">Collections</span>
                <div className="incoming__chips" aria-labelledby="incoming-collections">
                  {chosen.map((id) => (
                    <span key={id} className="chip">
                      {collectionPath(collections, id) || 'Collection'}
                      <button
                        type="button"
                        className="chip__remove"
                        aria-label={`Remove from ${collectionPath(collections, id)}`}
                        onClick={() =>
                          setChosen((current) => current.filter((item) => item !== id))
                        }
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  <select
                    className="edit incoming__add-collection"
                    aria-label="Add to a collection"
                    value=""
                    onChange={(event) =>
                      event.target.value && setChosen((current) => [...current, event.target.value])
                    }
                  >
                    <option value="">
                      {chosen.length ? '+ Collection' : 'None · + Collection'}
                    </option>
                    {choices
                      .filter((choice) => !chosen.includes(choice.id))
                      .map((choice) => (
                        <option key={choice.id} value={choice.id}>
                          {choice.path}
                        </option>
                      ))}
                  </select>
                </div>
              </div>
            </>
          )}
          <div className="incoming__field">
            <span>Folder</span>
            <FolderPicker
              library={library}
              value={picked?.folder ?? folder}
              pending={picked?.pending ?? []}
              allowNew
              onChange={(next, pending) => setChoice({ folder: next, pending })}
            />
          </div>
          {target.kind === 'new-bundle' && choice === null && existing.isPending && (
            <p role="status">Finding a destination folder…</p>
          )}
          {target.kind === 'new-bundle' && choice === null && existing.isError && (
            <p role="alert">The folder suggestion is unavailable. Choose a destination folder.</p>
          )}
          {bundle && choice === null && suggestion.isPending && (
            <p role="status">Finding a destination folder…</p>
          )}
          {bundle && choice === null && suggestion.isError && (
            <p role="alert">The folder suggestion is unavailable. Choose a destination folder.</p>
          )}
          {writeMode.data && !enabled && (
            <p className="incoming__off" role="status">
              {writeMode.data.allowed_by_deployment
                ? 'Write mode is off for this library. Turn it on in Libraries to add files to it.'
                : 'This server does not allow write mode, so it cannot add files to this library.'}
            </p>
          )}
          <div className="modal__actions">
            <button type="button" className="btn" onClick={close}>
              Cancel
            </button>
            {writeMode.data && !enabled && writeMode.data.allowed_by_deployment ? (
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => {
                  onClose()
                  onManage()
                }}
              >
                Open Libraries…
              </button>
            ) : (
              <button
                type="submit"
                className="btn btn--primary"
                disabled={!enabled || !folderReady}
              >
                Copy
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  )
}

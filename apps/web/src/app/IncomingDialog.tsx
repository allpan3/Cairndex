import { useMemo, useState } from 'react'
import { operationId } from '../api/catalog'
import { useWriteMode } from '../api/hooks'
import { formatBytes } from '../lib/format'
import { FolderPicker } from './FolderPicker'
import { folderLabel, joinPath, noun, suggestBundleTitle } from './sourceTasks'
import type { CatalogCollection } from './useCatalogCollections'
import { useModalDialog } from './useModalDialog'
import type { NewTask } from './useSourceTasks'

/**
 * What files from this computer become, decided by where they were dropped:
 * a new bundle (the Bundle Browser), more files of one bundle (a bundle card),
 * or plain files in a folder (the File Browser). Each target suggests a folder.
 */
export type IncomingTarget =
  | { kind: 'new-bundle'; collection: string | null; folder: string }
  | { kind: 'bundle'; bundle: string; title: string; folder: string }
  | { kind: 'folder'; folder: string }

function collectionPath(items: CatalogCollection[], id: string): string {
  const byId = new Map(items.map((item) => [item.id, item]))
  const names: string[] = []
  for (let item = byId.get(id); item && names.length < 32; item = byId.get(item.parent_id ?? ''))
    names.unshift(item.name)
  return names.join(' / ')
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
  const [folder, setFolder] = useState(target.folder)
  const [title, setTitle] = useState(() => suggestBundleTitle(files))
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
    const items = files.map((file) => ({
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
            if (enabled) start()
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
            <FolderPicker library={library} value={folder} onChange={setFolder} />
          </div>
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
              <button type="submit" className="btn btn--primary" disabled={!enabled}>
                Copy
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  )
}

import { useState } from 'react'
import {
  authorizeConversionStorage,
  type ConversionHistory,
  type ConversionInspection,
} from '../api/libraryConversion'
import { StorageAccessNotice } from './StorageAccessNotice'
import { useLibraryConversion } from './useLibraryConversion'
import { useModalDialog } from './useModalDialog'

const labels: Record<string, string> = {
  bundles: 'Bundles',
  files: 'Files',
  tags: 'Tags',
  collections: 'Collections',
  tag_groups: 'Tag groups',
  smart_collections: 'Smart Collections',
  moments: 'Moments',
  bundle_tags: 'Bundle tags',
  bundle_collections: 'Collection membership',
  moment_tags: 'Moment tags',
  tag_group_tags: 'Tag group membership',
  resume_positions: 'Resume positions',
  last_opened: 'Last-opened times',
  trashed_items: 'Trashed items',
  grouping_suggestions: 'Grouping suggestions',
  retired_notes: 'Retired single notes',
  retired_moments: 'Retired moment data',
}

function Counts({ title, values }: { title: string; values: Record<string, number> }) {
  return (
    <section>
      <h3>{title}</h3>
      <dl className="conversion-counts">
        {Object.entries(values).map(([key, count]) => (
          <div key={key}>
            <dt>{labels[key] ?? key.replaceAll('_', ' ')}</dt>
            <dd>{count}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

function Inspection({ value }: { value: ConversionInspection }) {
  return (
    <>
      <h3>{value.display_name}</h3>
      <div className="conversion-report">
        <Counts title="Converts" values={value.converts ?? {}} />
        <Counts title="Stays in the old metadata backup" values={value.stays_in_backup ?? {}} />
      </div>
      {value.caches && (
        <p>Old thumbnails and caches stay in the backup. The new version rebuilds them.</p>
      )}
      {value.passphrase && (
        <p>
          The old passphrase does not convert. Set access protection again on this server after
          conversion.
        </p>
      )}
      {(value.lease === 'stale' || value.lease === 'unreadable') && (
        <p className="conversion-warning">
          The old ownership record cannot prove that its server stopped. Stop every old app and
          server before you convert.
        </p>
      )}
      {(value.blocking?.length ?? 0) > 0 && (
        <div role="alert">
          <h3>Conversion is blocked</h3>
          <ul>
            {value.blocking!.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  )
}

/** The owner reviews the retained metadata before the exact prepared swap. */
export function LibraryConversionDialog({
  root,
  history,
  remember,
  onClose,
  onOpen,
}: {
  root: string | null
  history: ConversionHistory
  remember: (value: ConversionHistory) => void
  onClose: () => void
  onOpen: (library: string) => void
}) {
  const conversion = useLibraryConversion(root, history, remember, onOpen)
  const [stopped, setStopped] = useState(false)
  const [undoConfirmed, setUndoConfirmed] = useState(false)
  const { ref, close } = useModalDialog(
    onClose,
    conversion.swapping || (conversion.busy && !conversion.current),
  )
  const { current, inspection, review, converted, restored, busy } = conversion
  const failedSwap = current?.state === 'failed' && ['activate', 'undo'].includes(current.action)
  const blocked = !inspection || (inspection.blocking?.length ?? 0) > 0
  const inspect = () => {
    setStopped(false)
    setUndoConfirmed(false)
    conversion.begin('inspect')
  }
  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div
        className="modal conversion-dialog"
        ref={ref}
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="conversion-title"
      >
        <div className="modal__head">
          <h2 id="conversion-title">Convert old library</h2>
          <button
            className="modal__close"
            aria-label="Close conversion"
            onClick={close}
            disabled={conversion.swapping}
          >
            ×
          </button>
        </div>
        <p className="conversion-path">{conversion.root}</p>
        <p>
          Conversion changes the library metadata format. It keeps the old metadata folder beside
          the new one. It does not read or change media files.
        </p>
        {current && (
          <p role="status">
            {busy
              ? `${current.action === 'inspect' ? 'Inspecting' : current.action === 'prepare' ? 'Preparing' : current.action === 'activate' ? 'Converting' : 'Restoring'} library…`
              : restored
                ? 'The old library is restored.'
                : failedSwap
                  ? 'The metadata swap stopped. Retry the same step.'
                  : converted
                    ? 'Conversion completed.'
                    : current.state === 'interrupted'
                      ? 'Preparation stopped. Prepare again.'
                      : review
                        ? 'Review the prepared conversion.'
                        : 'Inspection finished.'}
          </p>
        )}
        {inspection && <Inspection value={inspection} />}
        {review && !restored && (
          <p>
            Old metadata backup: <code>{review.backup_name}</code>. Conversion keeps its contents
            unchanged.
          </p>
        )}
        {restored && (
          <p>
            The converted metadata stays in <code>{current?.result?.retained}</code>. Its private
            work stays on this server. You can use the restored library with the old version.
          </p>
        )}
        {review && !converted && !restored && !failedSwap && (
          <label className="conversion-check">
            <input
              type="checkbox"
              checked={stopped}
              onChange={(event) => setStopped(event.target.checked)}
              disabled={busy}
            />
            I stopped every old app and server that uses this library. They will stay stopped until
            conversion finishes.
          </label>
        )}
        {(converted || failedSwap) && (
          <>
            <p>
              Undo restores the old metadata. It keeps converted metadata and private work, but does
              not merge new edits into the old library. Undo does not reverse later file operations.
              Release this library on every server before Undo.
            </p>
            <label className="conversion-check">
              <input
                type="checkbox"
                checked={undoConfirmed}
                onChange={(event) => setUndoConfirmed(event.target.checked)}
                disabled={busy}
              />
              I released the library on every server. I understand what Undo keeps.
            </label>
          </>
        )}
        {conversion.error && (
          <p className="modal__error" role="alert">
            {conversion.error}
          </p>
        )}
        {failedSwap && current.error_code === 'storage_authorization' && (
          <StorageAccessNotice
            access="authorization"
            showMessage={false}
            authorize={() => authorizeConversionStorage(current.id)}
            onAuthorized={conversion.retry}
          />
        )}
        {conversion.task.isError && (
          <p>
            The server has no readable result yet. Check the connection, then refresh. If it never
            accepted this step, inspect the folder again.
          </p>
        )}
        <div className="modal__actions">
          {(!current ||
            current.action === 'inspect' ||
            current.state === 'interrupted' ||
            (current.state === 'failed' && !failedSwap) ||
            restored) && (
            <button className="btn" disabled={busy || !conversion.root} onClick={inspect}>
              {current ? 'Inspect again' : 'Inspect library'}
            </button>
          )}
          {conversion.task.isError && (
            <button className="btn" disabled={busy} onClick={conversion.refresh}>
              Refresh result
            </button>
          )}
          {!review && inspection && !blocked && (
            <button
              className="btn btn--primary"
              disabled={busy}
              onClick={() => conversion.begin('prepare')}
            >
              Prepare conversion
            </button>
          )}
          {review && !converted && !restored && !failedSwap && (
            <button
              className="btn btn--primary"
              disabled={busy || !current || !stopped || blocked}
              onClick={() => conversion.begin('activate', stopped)}
            >
              Convert library
            </button>
          )}
          {failedSwap && (
            <button className="btn btn--primary" disabled={busy} onClick={conversion.retry}>
              Retry {current.action === 'activate' ? 'conversion' : 'Undo'}
            </button>
          )}
          {converted && (
            <>
              <button className="btn" disabled={busy} onClick={conversion.release}>
                Release converted library
              </button>
              <button
                className="btn btn--primary"
                disabled={busy || current?.action === 'undo'}
                onClick={conversion.open}
              >
                Open converted library
              </button>
            </>
          )}
          {(converted || failedSwap) && current?.action !== 'undo' && (
            <button
              className="btn btn--danger"
              disabled={busy || !undoConfirmed}
              onClick={() => conversion.begin('undo')}
            >
              Undo conversion
            </button>
          )}
          <span className="toolbar__spacer" />
          <button className="btn" disabled={conversion.swapping} onClick={close}>
            Close
          </button>
        </div>
        {busy && !conversion.swapping && (
          <p>Closing this dialog keeps the server task running. Resume it from Libraries.</p>
        )}
      </div>
    </div>
  )
}

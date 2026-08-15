import { useMemo, useState } from 'react'

import { defaultSnapshotWidth, snapshotHeight, snapshotWidthOptions } from './snapshotExport'
import { WheelPicker } from './WheelPicker'

/**
 * Pick a size for one snapshot.
 *
 * Only reached through "Snapshot As…" — `S` and the camera button stay a single
 * press at the source's own resolution (owner, 2026-08-15), because the common
 * case is grabbing a frame, not configuring one.
 */
export function SnapshotDialog({
  title,
  sourceWidth,
  sourceHeight,
  onSave,
  onClose,
}: {
  title: string
  sourceWidth: number
  sourceHeight: number
  onSave: (width: number) => void
  onClose: () => void
}) {
  const options = useMemo(() => snapshotWidthOptions(sourceWidth), [sourceWidth])
  const [width, setWidth] = useState(() => defaultSnapshotWidth(options))
  const height = snapshotHeight(width, sourceWidth, sourceHeight)

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="modal modal--narrow"
        role="dialog"
        aria-modal="true"
        aria-label="Snapshot options"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h3 className="modal__title">Snapshot</h3>
        <p className="modal__sub">{title}</p>

        <label className="field-label" htmlFor="snap-width">
          Width
        </label>
        <WheelPicker
          id="snap-width"
          label="Snapshot width"
          options={options}
          value={width}
          onChange={setWidth}
        />

        <p className="modal__note">
          {width}×{height} PNG
          {width === sourceWidth ? ' · the frame as it is' : ''}
        </p>

        <div className="modal__actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            onClick={() => {
              onClose()
              onSave(width)
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

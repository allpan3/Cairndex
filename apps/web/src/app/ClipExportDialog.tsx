import { useMemo, useState } from 'react'

import {
  clipFpsOptions,
  defaultClipFps,
  clipWidthOptions,
  defaultClipWidth,
  gifPlaybackRate,
  isExactGifRate,
  isWidthCapped,
  outputHeight,
  saveClipGif,
  type ClipExportRange,
  type ClipExportTarget,
} from './clipExport'
import { WheelPicker } from './WheelPicker'

/**
 * Output size and frame rate for one GIF, asked after the range is picked.
 *
 * A dialog rather than more controls in the clip bar, unlike the range itself:
 * choosing a width does not need the frame on screen, and the bar was
 * deliberately trimmed to three rows. This is the shape the contact sheet's
 * options already use.
 */
export function ClipExportDialog({
  target,
  range,
  onClose,
  onReport,
}: {
  target: ClipExportTarget
  range: ClipExportRange
  onClose: () => void
  onReport: (message: string | null) => void
}) {
  const widths = useMemo(() => clipWidthOptions(target.sourceWidth), [target.sourceWidth])
  const rates = useMemo(() => clipFpsOptions(target.sourceFps), [target.sourceFps])
  const [width, setWidth] = useState(() => defaultClipWidth(widths))
  const [fps, setFps] = useState(() => defaultClipFps(rates))

  const height = outputHeight(width, target.sourceWidth, target.sourceHeight)
  const seconds = range.end - range.start
  const frames = Math.max(1, Math.round(seconds * fps))
  // A rate the format cannot hold exactly stretches the clip as well as slowing
  // it: 90 frames asked for at 15 fps are stored at 7cs each and run 6.30s, not
  // the 6.00s of source they came from. Report what the file will do.
  const playbackRate = gifPlaybackRate(fps)
  const playbackSeconds = frames / playbackRate
  const drifts = !isExactGifRate(fps)
  // Said only when the largest option is the server's ceiling rather than the
  // source's own size, so the missing "Original" is explained.
  const capped = isWidthCapped(target.sourceWidth)

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="modal modal--narrow"
        role="dialog"
        aria-modal="true"
        aria-label="GIF options"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h3 className="modal__title">Save GIF</h3>
        <p className="modal__sub">{target.title}</p>

        <label className="field-label" htmlFor="clip-width">
          Width
        </label>
        <WheelPicker
          id="clip-width"
          label="Output width"
          options={widths}
          value={width}
          onChange={setWidth}
        />

        <label className="field-label" htmlFor="clip-fps">
          Frame rate
        </label>
        <WheelPicker
          id="clip-fps"
          label="Frame rate"
          options={rates}
          value={fps}
          onChange={setFps}
        />

        {/* What the two choices produce. A GIF's byte size swings several-fold
            with how much of the picture moves, so frames and dimensions are
            what can be said honestly; a megabyte estimate could not. */}
        <p className="modal__note">
          {height ? `${width}×${height}` : `${width}px wide`} · {frames} frames ·{' '}
          {playbackSeconds.toFixed(2)} s{drifts ? ` (plays at ${playbackRate.toFixed(1)} fps)` : ''}
          {capped ? ' · larger than the maximum, so capped' : ''}
        </p>

        <div className="modal__actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            onClick={() => {
              onClose()
              void saveClipGif(target, range, { width, fps }, onReport)
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

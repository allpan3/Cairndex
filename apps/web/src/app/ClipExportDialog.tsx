import { useMemo, useState } from 'react'

import {
  CLIP_FPS_CHOICES,
  DEFAULT_CLIP_FPS,
  clipWidthOptions,
  defaultClipWidth,
  isWidthCapped,
  outputHeight,
  saveClipGif,
  type ClipExportRange,
  type ClipExportTarget,
} from './clipExport'

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
  const [width, setWidth] = useState(() => defaultClipWidth(widths))
  const [fps, setFps] = useState<number>(DEFAULT_CLIP_FPS)

  const height = outputHeight(width, target.sourceWidth, target.sourceHeight)
  const seconds = range.end - range.start
  const frames = Math.max(1, Math.round(seconds * fps))
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
        <div className="segmented" id="clip-width" role="group" aria-label="Output width">
          {widths.map((option) => (
            <button
              key={option.value}
              className={`seg${option.value === width ? ' is-active' : ''}`}
              onClick={() => setWidth(option.value)}
              aria-pressed={option.value === width}
              title={`${option.value}px wide`}
            >
              {option.label}
            </button>
          ))}
        </div>

        <label className="field-label" htmlFor="clip-fps">
          Frame rate
        </label>
        <div className="segmented" id="clip-fps" role="group" aria-label="Frame rate">
          {CLIP_FPS_CHOICES.map((option) => (
            <button
              key={option}
              className={`seg${option === fps ? ' is-active' : ''}`}
              onClick={() => setFps(option)}
              aria-pressed={option === fps}
            >
              {option} fps
            </button>
          ))}
        </div>

        {/* What the two choices produce. A GIF's byte size swings several-fold
            with how much of the picture moves, so frames and dimensions are
            what can be said honestly; a megabyte estimate could not. */}
        <p className="modal__note">
          {height ? `${width}×${height}` : `${width}px wide`} · {seconds.toFixed(2)} s · {frames}{' '}
          frames
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

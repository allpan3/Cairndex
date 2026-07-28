import { useState } from 'react'

import {
  CONTACT_SHEET_GRIDS,
  CONTACT_SHEET_WIDTHS,
  type ContactSheetGrid,
  type ContactSheetTarget,
  type ContactSheetWidth,
  saveContactSheet,
} from './contactSheetExport'
import { formatDuration } from '../lib/format'

/**
 * Choose a contact sheet's shape before building it.
 *
 * The grid started as a submenu, but width belongs in the same choice and a
 * two-level menu of twelve combinations is a worse way to ask (owner,
 * 2026-07-27). A dialog also has room to say what the numbers mean: the cell
 * size follows from both, and that — not the sheet width — is what decides
 * whether a frame is legible.
 */
export function ContactSheetDialog({
  target,
  onClose,
  onReport,
}: {
  target: ContactSheetTarget
  onClose: () => void
  onReport: (message: string | null) => void
}) {
  const [grid, setGrid] = useState<ContactSheetGrid>(4)
  const [width, setWidth] = useState<ContactSheetWidth>(1600)

  const cell = Math.round(width / grid)
  const frames = grid * grid
  // Only worth saying when the interval is longer than the unit we print it in.
  const interval = target.duration ? target.duration / frames : 0
  const every = interval >= 1 ? formatDuration(interval) : null

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="modal modal--narrow"
        role="dialog"
        aria-modal="true"
        aria-label="Contact sheet options"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h3 className="modal__title">Contact Sheet</h3>
        <p className="modal__sub">{target.title}</p>

        <label className="field-label" htmlFor="cs-grid">
          Grid
        </label>
        <div className="segmented" id="cs-grid" role="group" aria-label="Grid size">
          {CONTACT_SHEET_GRIDS.map((option) => (
            <button
              key={option}
              className={`seg${option === grid ? ' is-active' : ''}`}
              onClick={() => setGrid(option)}
              aria-pressed={option === grid}
            >
              {option} × {option}
            </button>
          ))}
        </div>

        <label className="field-label" htmlFor="cs-width">
          Width
        </label>
        <div className="segmented" id="cs-width" role="group" aria-label="Sheet width">
          {CONTACT_SHEET_WIDTHS.map((option) => (
            <button
              key={option}
              className={`seg${option === width ? ' is-active' : ''}`}
              onClick={() => setWidth(option)}
              aria-pressed={option === width}
            >
              {option}px
            </button>
          ))}
        </div>

        {/* What the two choices actually produce, since neither number means
            much alone: a 6x6 at 1280 has smaller frames than a 4x4 at 1280. */}
        <p className="modal__note">
          {frames} frames at {cell}px wide
          {every ? `, roughly one every ${every}` : ''}.
        </p>

        <div className="modal__actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            onClick={() => {
              onClose()
              void saveContactSheet(target, grid, width, onReport)
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

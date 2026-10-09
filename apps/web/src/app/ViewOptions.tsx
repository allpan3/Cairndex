import { useState } from 'react'
import { createPortal } from 'react-dom'

import { useModalDialog } from './useModalDialog'

interface ViewOptionsProps<T extends string> {
  layout: T
  layouts: { value: T; label: string }[]
  onLayout: (layout: T) => void
  zoom: number
  min: number
  max: number
  onZoom: (zoom: number) => void
  onAddFiles?: () => void
  addFilesDisabled?: boolean
}

// Keep sizing and layout reachable when the toolbar has no room for inline controls
export function ViewOptions<T extends string>(props: ViewOptionsProps<T>) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        className="seg toolbar__view-options"
        aria-label="View options"
        title="View options: layout and item size"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(event) => {
          // WebKit does not focus buttons on pointer activation
          event.currentTarget.focus({ preventScroll: true })
          setOpen(true)
        }}
      >
        •••
      </button>
      {open &&
        createPortal(
          <ViewOptionsDialog {...props} onClose={() => setOpen(false)} />,
          document.body,
        )}
    </>
  )
}

// Reuse modal focus and Escape behavior without touching the browsing selection
function ViewOptionsDialog<T extends string>({
  layout,
  layouts,
  onLayout,
  zoom,
  min,
  max,
  onZoom,
  onAddFiles,
  addFilesDisabled,
  onClose,
}: ViewOptionsProps<T> & { onClose: () => void }) {
  const { ref, close } = useModalDialog(onClose)
  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div
        className="modal view-options"
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="view-options-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal__head">
          <h2 id="view-options-title">View options</h2>
          <button className="modal__close" aria-label="Close view options" onClick={close}>
            ×
          </button>
        </div>
        <label className="view-options__field">
          Layout
          <select value={layout} onChange={(event) => onLayout(event.target.value as T)}>
            {layouts.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label className="view-options__field">
          Item size
          <input
            type="range"
            min={min}
            max={max}
            step={10}
            value={zoom}
            onChange={(event) => onZoom(Number(event.target.value))}
          />
        </label>
        {onAddFiles && (
          <button className="btn" disabled={addFilesDisabled} onClick={onAddFiles}>
            Add Files Here
          </button>
        )}
      </div>
    </div>
  )
}

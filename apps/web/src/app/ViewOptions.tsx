import type { ReactNode } from 'react'
import { usePopover } from './usePopover'
import { IconSettings } from './icons'
import { createPortal } from 'react-dom'

import { useModalDialog } from './useModalDialog'
import { ZoomSlider } from './ZoomSlider'

interface ViewOptionsProps<T extends string> {
  sortControls?: ReactNode
  showDetails?: boolean
  onShowDetails?: (show: boolean) => void
  alwaysVisible?: boolean
  layout: T
  layouts: { value: T; label: string }[]
  onLayout: (layout: T) => void
  zoom: number
  min: number
  max: number
  onZoom: (zoom: number) => void
  onZoomPreview?: (zoom: number | null) => void
  onAddFiles?: () => void
  addFilesDisabled?: boolean
}

// Keep sizing and layout reachable when the toolbar has no room for inline controls
export function ViewOptions<T extends string>(props: ViewOptionsProps<T>) {
  const { open, setOpen, ref, panelRef, pos } = usePopover()
  return (
    <div ref={ref} className="picker">
      <button
        className={`seg toolbar__view-options${props.alwaysVisible ? ' toolbar__view-options--full' : ''}`}
        aria-label="View options"
        title="View options"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(event) => {
          // WebKit does not focus buttons on pointer activation
          event.currentTarget.focus({ preventScroll: true })
          setOpen(true)
        }}
      >
        <IconSettings />
      </button>
      {open &&
        pos &&
        createPortal(
          <ViewOptionsDialog
            {...props}
            position={pos}
            panelRef={panelRef}
            onClose={() => setOpen(false)}
          />,
          document.body,
        )}
    </div>
  )
}

// Reuse modal focus and Escape behavior without touching the browsing selection
function ViewOptionsDialog<T extends string>({
  sortControls,
  showDetails,
  onShowDetails,
  position,
  panelRef,
  layout,
  layouts,
  onLayout,
  zoom,
  min,
  max,
  onZoom,
  onZoomPreview,
  onAddFiles,
  addFilesDisabled,
  onClose,
}: ViewOptionsProps<T> & {
  onClose: () => void
  position: React.CSSProperties
  panelRef: React.RefObject<HTMLDivElement | null>
}) {
  const { ref, close } = useModalDialog(onClose)
  return (
    <div
      className="picker__panel view-options"
      style={position}
      ref={(element) => {
        ref.current = element
        panelRef.current = element
      }}
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
        <ZoomSlider
          value={zoom}
          min={min}
          max={max}
          label="Item size"
          onPreview={onZoomPreview}
          onCommit={onZoom}
        />
      </label>
      {sortControls}
      {onShowDetails && (
        <label className="sortctl__scope">
          <input
            type="checkbox"
            checked={showDetails ?? true}
            disabled={layout !== 'grid'}
            onChange={(event) => onShowDetails(event.target.checked)}
          />
          Card details
        </label>
      )}
      {onAddFiles && (
        <button className="btn" disabled={addFilesDisabled} onClick={onAddFiles}>
          Add Files Here
        </button>
      )}
    </div>
  )
}

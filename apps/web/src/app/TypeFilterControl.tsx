import { createPortal } from 'react-dom'
import type { AdHocFilters } from './adHocFilters'
import { usePopover } from './usePopover'

/** Extension predicates run on the server over every matching bundle. */
export function TypeFilterControl({
  filters,
  onChange,
}: {
  filters: AdHocFilters
  onChange: (filters: AdHocFilters) => void
}) {
  const { open, setOpen, ref, panelRef, pos } = usePopover()
  const value = filters.extension ?? ''
  return (
    <div className="picker" ref={ref}>
      <button
        className={`filterchip${value ? ' is-active' : ''}`}
        aria-label="File type filter"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {value ? `Type: ${value.toUpperCase()}` : 'File type'}
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            className="picker__panel type-filter"
            ref={panelRef}
            style={pos}
            role="dialog"
            aria-label="File type filter"
          >
            <label className="view-options__field">
              File extension
              <input
                className="edit"
                value={value}
                autoFocus
                placeholder="jpg, mp4, pdf…"
                onChange={(event) =>
                  onChange({
                    ...filters,
                    extension: event.target.value.trim().replace(/^\./, '').toLowerCase() || null,
                  })
                }
              />
            </label>
            <div className="type-filter__choices">
              {['jpg', 'png', 'gif', 'webp', 'mp4', 'mkv', 'mov', 'mp3', 'pdf'].map((extension) => (
                <button
                  key={extension}
                  className="add-btn"
                  aria-pressed={value === extension}
                  onClick={() => onChange({ ...filters, extension })}
                >
                  {extension.toUpperCase()}
                </button>
              ))}
            </div>
            <button
              className="btn btn--sm"
              disabled={!value}
              onClick={() => onChange({ ...filters, extension: null })}
            >
              Clear file type
            </button>
          </div>,
          document.body,
        )}
    </div>
  )
}

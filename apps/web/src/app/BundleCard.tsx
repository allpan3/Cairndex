import type { BundleSummary } from '../api/client'
import { thumbnailUrl } from '../api/client'
import { formatDimensions, formatDuration } from '../lib/format'

interface BundleCardProps {
  item: BundleSummary
  selected: boolean
  showMeta: boolean
  onSelect: (id: string, e: React.MouseEvent) => void
  onOpen: (id: string) => void
  onContextMenu: (id: string, e: React.MouseEvent) => void
}

export function BundleCard({
  item,
  selected,
  showMeta,
  onSelect,
  onOpen,
  onContextMenu,
}: BundleCardProps) {
  return (
    <div
      className={`card${selected ? ' card--selected' : ''}`}
      onClick={(e) => onSelect(item.id, e)}
      onDoubleClick={() => onOpen(item.id)}
      onContextMenu={(e) => onContextMenu(item.id, e)}
      role="option"
      aria-selected={selected}
      data-bundle-id={item.id}
    >
      <div
        className="card__thumb"
        style={item.has_cover ? { backgroundImage: `url(${thumbnailUrl(item.id)})` } : undefined}
      >
        {!item.has_cover && <div className="card__placeholder">▦</div>}
        {item.has_missing && <span className="card__badge card__badge--missing">missing</span>}
        {!item.has_missing && item.grouping_state === 'provisional' && (
          <span className="card__badge card__badge--review">review</span>
        )}
        {!item.has_missing && item.grouping_state !== 'provisional' && item.extension && (
          <span className="card__badge">{item.extension}</span>
        )}
        {item.file_count > 1 && (
          <span className="card__badge" style={{ left: 'auto', right: 6 }}>
            {item.file_count}
          </span>
        )}
        {item.duration ? <span className="card__dur">{formatDuration(item.duration)}</span> : null}
      </div>
      {showMeta && (
        <div className="card__meta">
          <div className="card__title">{item.title ?? 'Untitled'}</div>
          <div className="card__sub">
            <span>
              {item.duration
                ? formatDuration(item.duration)
                : formatDimensions(item.width, item.height)}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

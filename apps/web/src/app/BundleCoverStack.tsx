import { thumbnailUrl } from '../api/client'
import type { BundleCardItem } from './BundleCard'
import { CoverImage } from './CoverImage'
import { IconLayers } from './icons'

/** Only the first three selected cards load covers, regardless of selection size. */
export function BundleCoverStack({ items }: { items: BundleCardItem[] }) {
  return (
    <div className="bundle-cover-stack" role="img" aria-label="Selected bundle covers">
      {items.slice(0, 3).map((item, index) => (
        <div
          key={item.id}
          className="bundle-cover-stack__card"
          style={{
            transform: `translate(${(index - 1) * 24}px, ${Math.abs(index - 1) * 8}px) rotate(${(index - 1) * 9}deg)`,
            zIndex: 3 - index,
          }}
        >
          {item.has_cover ? (
            <CoverImage src={thumbnailUrl(item.id, item.cover_key)} />
          ) : (
            <IconLayers />
          )}
        </div>
      ))}
    </div>
  )
}

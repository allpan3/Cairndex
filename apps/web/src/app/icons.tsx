/**
 * Inline SVG icons (monochrome, `currentColor`) used across the sidebar and the
 * File Browser. Inline SVG has no font/codepoint dependency, so icons render the
 * same everywhere regardless of installed fonts. Paths follow the Lucide line
 * style (24×24 viewBox, 2px round strokes). Size/color are controlled by the
 * `.icon` CSS class and the surrounding text color.
 */
import type { ReactNode } from 'react'

function Svg({ children, className = 'icon' }: { children: ReactNode; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

/** Fold caret — a small solid triangle pointing down when open, right when
 * collapsed (the classic disclosure triangle; narrow so it barely widens a row).
 * `className` selects the size (`.chevron` default, `.chevron--lg` for section
 * headings). */
export const IconChevron = ({
  open = false,
  className = 'chevron',
}: {
  open?: boolean
  className?: string
}) => (
  <Svg className={className}>
    {open ? (
      <polygon points="6 9 18 9 12 16" fill="currentColor" stroke="none" />
    ) : (
      <polygon points="9 6 16 12 9 18" fill="currentColor" stroke="none" />
    )}
  </Svg>
)

export const IconPlus = () => (
  <Svg>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </Svg>
)

export const IconGrid = () => (
  <Svg>
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="14" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
  </Svg>
)

export const IconClock = () => (
  <Svg>
    <circle cx="12" cy="12" r="9" />
    <polyline points="12 7 12 12 16 14" />
  </Svg>
)

export const IconCircleDashed = () => (
  <Svg>
    <circle cx="12" cy="12" r="9" strokeDasharray="4 3" />
  </Svg>
)

export const IconTag = () => (
  <Svg>
    <path d="M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4z" />
    <circle cx="7.5" cy="7.5" r="0.8" fill="currentColor" stroke="none" />
  </Svg>
)

export const IconAlert = () => (
  <Svg>
    <path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3Z" />
    <line x1="12" x2="12" y1="9" y2="13" />
    <line x1="12" x2="12.01" y1="17" y2="17" />
  </Svg>
)

export const IconFolder = () => (
  <Svg>
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.6 3.9A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
  </Svg>
)

// Folder marked with a "?" — the "Uncategorized" (no collection) view.
export const IconFolderQuestion = () => (
  <Svg>
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.6 3.9A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    <text
      x="12"
      y="15"
      fontSize="9"
      fontWeight="700"
      fill="currentColor"
      stroke="none"
      textAnchor="middle"
      dominantBaseline="central"
    >
      ?
    </text>
  </Svg>
)

// Tag marked with a "?" — the "Untagged" (no tags) view, distinct from All Tags.
export const IconTagQuestion = () => (
  <Svg>
    <path d="M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4z" />
    <text
      x="8"
      y="8"
      fontSize="7.5"
      fontWeight="700"
      fill="currentColor"
      stroke="none"
      textAnchor="middle"
      dominantBaseline="central"
    >
      ?
    </text>
  </Svg>
)

// Loose stack — three scattered, slightly-tilted tiles standing for loose,
// ungrouped files awaiting bundling (the Unbundled view).
export const IconLooseStack = () => (
  <Svg>
    <rect x="3" y="4" width="7" height="7" rx="1.5" transform="rotate(-10 6.5 7.5)" />
    <rect x="14" y="5" width="7" height="7" rx="1.5" transform="rotate(9 17.5 8.5)" />
    <rect x="8.5" y="13" width="7" height="7" rx="1.5" transform="rotate(-4 12 16.5)" />
  </Svg>
)

export const IconFilter = () => (
  <Svg>
    <polygon points="22 3 2 3 10 12.5 10 19 14 21 14 12.5 22 3" />
  </Svg>
)

export const IconFilm = () => (
  <Svg>
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <path d="M7 3v18M3 7.5h4M3 12h18M3 16.5h4M17 3v18M17 7.5h4M17 16.5h4" />
  </Svg>
)

export const IconImage = () => (
  <Svg>
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <circle cx="9" cy="9" r="2" />
    <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
  </Svg>
)

export const IconMusic = () => (
  <Svg>
    <path d="M9 18V5l12-2v13" />
    <circle cx="6" cy="18" r="3" />
    <circle cx="18" cy="16" r="3" />
  </Svg>
)

export const IconCaptions = () => (
  <Svg>
    <rect width="18" height="14" x="3" y="5" rx="2" />
    <path d="M7 15h4M15 15h2M7 11h2M13 11h4" />
  </Svg>
)

export const IconFile = () => (
  <Svg>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M14 2v4a2 2 0 0 0 2 2h4" />
  </Svg>
)

/** Checkbox-with-check glyph — the "show only selected" filter toggle. */
export const IconCheckSquare = () => (
  <Svg>
    <rect x="3" y="3" width="18" height="18" rx="4" />
    <path d="M8 12l2.5 2.5L16 9" />
  </Svg>
)

export const IconPlay = () => (
  <Svg>
    <polygon points="8 5 19 12 8 19 8 5" fill="currentColor" stroke="none" />
  </Svg>
)

export const IconPause = () => (
  <Svg>
    <rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" />
    <rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" />
  </Svg>
)

export const IconVolume = () => (
  <Svg>
    <polygon points="4 9 8 9 13 4 13 20 8 15 4 15 4 9" />
    <path d="M16 9.5a4 4 0 0 1 0 5" />
    <path d="M18.5 7a8 8 0 0 1 0 10" />
  </Svg>
)

export const IconVolumeOff = () => (
  <Svg>
    <polygon points="4 9 8 9 13 4 13 20 8 15 4 15 4 9" />
    <path d="M16 9l5 5" />
    <path d="M21 9l-5 5" />
  </Svg>
)

export const IconCamera = () => (
  <Svg>
    <path d="M14.5 4 16 7h3a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h3l1.5-3Z" />
    <circle cx="12" cy="13" r="3" />
  </Svg>
)

export const IconPictureInPicture = () => (
  <Svg>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <rect x="12" y="11" width="6" height="4" rx="1" />
  </Svg>
)

export const IconFullscreen = () => (
  <Svg>
    <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
  </Svg>
)

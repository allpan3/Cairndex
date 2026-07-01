/**
 * Inline SVG icons (monochrome, `currentColor`) used across the sidebar and the
 * File View. Inline SVG has no font/codepoint dependency, so icons render the
 * same everywhere regardless of installed fonts. Paths follow the Lucide line
 * style (24×24 viewBox, 2px round strokes). Size/color are controlled by the
 * `.icon` CSS class and the surrounding text color.
 */
import type { ReactNode } from 'react'

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg
      className="icon"
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

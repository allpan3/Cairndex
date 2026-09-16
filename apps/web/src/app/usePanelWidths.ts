import { useEffect, useState } from 'react'

// Reserve a usable listing while shrinking panel space above their existing minima
export function fitPanelWidths(viewport: number, sidebar: number, inspector: number) {
  const leftMin = sidebar ? 180 : 0
  const rightMin = inspector ? 220 : 0
  const extra = Math.max(0, sidebar - leftMin) + Math.max(0, inspector - rightMin)
  const available = Math.max(0, viewport - 400 - leftMin - rightMin)
  const scale = extra ? Math.min(1, available / extra) : 1
  return {
    sidebar: leftMin + Math.max(0, sidebar - leftMin) * scale,
    inspector: rightMin + Math.max(0, inspector - rightMin) * scale,
  }
}

// Window resizing adjusts the rendered panels without overwriting preferred widths
export function usePanelWidths(sidebar: number, inspector: number) {
  const [viewport, setViewport] = useState(window.innerWidth)
  useEffect(() => {
    const resize = () => setViewport(window.innerWidth)
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  return fitPanelWidths(viewport, sidebar, inspector)
}

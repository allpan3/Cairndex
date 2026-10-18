/**
 * v0.2.1's drag handle on a side panel's inner edge. It sits over the seam,
 * positioned from the panel's own width, so it needs an offset parent that
 * spans the window (the portable layout is one).
 */
export function PanelResizer({
  side,
  width,
  setWidth,
  min,
  max,
}: {
  side: 'left' | 'right'
  width: number
  setWidth: (width: number) => void
  min: number
  max: number
}) {
  const onMouseDown = (event: React.MouseEvent) => {
    event.preventDefault()
    const startX = event.clientX
    const onMove = (move: MouseEvent) => {
      const delta = side === 'left' ? move.clientX - startX : startX - move.clientX
      setWidth(Math.max(min, Math.min(max, width + delta)))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
  }
  return (
    <div
      className="resizer-bar"
      style={{ position: 'absolute', top: 0, bottom: 0, width: 7, [side]: width - 3 }}
      onMouseDown={onMouseDown}
      role="separator"
      aria-orientation="vertical"
      aria-label={side === 'left' ? 'Resize sidebar' : 'Resize inspector'}
    />
  )
}

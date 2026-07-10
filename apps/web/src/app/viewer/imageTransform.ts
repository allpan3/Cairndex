export type ImageFitMode = 'fit' | 'actual' | 'fill' | 'custom'

export interface Size {
  width: number
  height: number
}

export interface Transform {
  scale: number
  tx: number
  ty: number
}

export type SourceTier = 'thumbnail' | 'preview1600' | 'preview2560' | 'original'

export const SOURCE_TIER_RANK: Record<SourceTier, number> = {
  thumbnail: 0,
  preview1600: 1,
  preview2560: 2,
  original: 3,
}

// Compute the contain-fit scale for an image inside a viewport
export function fitScale(viewport: Size, image: Size): number {
  if (viewport.width <= 0 || viewport.height <= 0 || image.width <= 0 || image.height <= 0) {
    return 1
  }
  return Math.min(1, viewport.width / image.width, viewport.height / image.height)
}

// Compute the cover-fill scale for an image inside a viewport
export function fillScale(viewport: Size, image: Size): number {
  if (viewport.width <= 0 || viewport.height <= 0 || image.width <= 0 || image.height <= 0) {
    return 1
  }
  return Math.max(viewport.width / image.width, viewport.height / image.height)
}

// Clamp zoom while still allowing fit/fill for very small images
export function clampScale(scale: number, fit: number, fill = fit): number {
  const min = fit * 0.5
  const max = Math.max(8, fit, fill)
  return Math.min(max, Math.max(min, scale))
}

// Return the target scale for a named fit mode
export function scaleForMode(mode: ImageFitMode, viewport: Size, image: Size): number {
  const fit = fitScale(viewport, image)
  if (mode === 'actual') return clampScale(1, fit, fillScale(viewport, image))
  if (mode === 'fill') return fillScale(viewport, image)
  return fit
}

// Cycle the double-click image fit sequence
export function nextFitMode(mode: ImageFitMode): ImageFitMode {
  if (mode === 'fit' || mode === 'custom') return 'actual'
  if (mode === 'actual') return 'fill'
  return 'fit'
}

// Zoom a transform around a viewport point relative to the viewport center
export function zoomToPoint(
  transform: Transform,
  nextScale: number,
  point: { x: number; y: number },
): Transform {
  if (transform.scale <= 0) return { scale: nextScale, tx: transform.tx, ty: transform.ty }
  const ratio = nextScale / transform.scale
  return {
    scale: nextScale,
    tx: point.x - (point.x - transform.tx) * ratio,
    ty: point.y - (point.y - transform.ty) * ratio,
  }
}

// Keep a custom transform from moving the image completely out of view
export function clampPan(transform: Transform, viewport: Size, image: Size): Transform {
  if (viewport.width <= 0 || viewport.height <= 0 || image.width <= 0 || image.height <= 0) {
    return transform
  }
  const renderedWidth = image.width * transform.scale
  const renderedHeight = image.height * transform.scale
  const maxX = Math.max(0, (renderedWidth - viewport.width) / 2)
  const maxY = Math.max(0, (renderedHeight - viewport.height) / 2)
  return {
    ...transform,
    tx: Math.min(maxX, Math.max(-maxX, transform.tx)),
    ty: Math.min(maxY, Math.max(-maxY, transform.ty)),
  }
}

// Pick the highest source tier currently worth loading
export function desiredTier(scale: number, nativeImage: boolean): SourceTier {
  if (nativeImage) return 'original'
  return scale > 1 ? 'preview2560' : 'preview1600'
}

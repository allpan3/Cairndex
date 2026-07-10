import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { FileRead } from '../../api/client'
import { fileContentUrl, filePreviewUrl, fileThumbnailUrl } from '../../api/client'
import {
  type ImageFitMode,
  type Size,
  type SourceTier,
  type Transform,
  SOURCE_TIER_RANK,
  clampPan,
  clampScale,
  desiredTier,
  fillScale,
  fitScale,
  nextFitMode,
  scaleForMode,
  zoomToPoint,
} from './imageTransform'
import { isBrowserNativeImage } from './imageSupport'

type BackgroundMode = 'dark' | 'light' | 'checker'

interface TierSource {
  tier: SourceTier
  src: string
}

interface PointerPoint {
  x: number
  y: number
}

interface PinchState {
  center: PointerPoint
  distance: number
  transform: Transform
}

interface InFlightTier {
  tier: SourceTier
  lifetime: symbol
}

const DEFAULT_SIZE: Size = { width: 1, height: 1 }

// Decode an image source before the visible stage swaps to it
function decodeImage(src: string): Promise<HTMLImageElement> {
  const image = new Image()
  image.decoding = 'async'
  image.src = src
  if (typeof image.decode === 'function') return image.decode().then(() => image)
  return new Promise((resolve, reject) => {
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error(`image failed to load: ${src}`))
  })
}

// Read known image dimensions from probed tech metadata when available
function metadataSize(file: FileRead): Size {
  const meta = (file.tech_metadata ?? {}) as Record<string, unknown>
  const width = typeof meta.width === 'number' && Number.isFinite(meta.width) ? meta.width : 0
  const height = typeof meta.height === 'number' && Number.isFinite(meta.height) ? meta.height : 0
  return width > 0 && height > 0 ? { width, height } : DEFAULT_SIZE
}

// Convert a pointer event into viewport-centered coordinates
function eventPoint(event: React.PointerEvent | WheelEvent, element: HTMLElement): PointerPoint {
  const rect = element.getBoundingClientRect()
  return {
    x: event.clientX - rect.left - rect.width / 2,
    y: event.clientY - rect.top - rect.height / 2,
  }
}

// Return the center and distance for two active pointers
function pinchGeometry(points: PointerPoint[]): { center: PointerPoint; distance: number } {
  const a = points[0]
  const b = points[1]
  if (!a || !b) return { center: { x: 0, y: 0 }, distance: 1 }
  return {
    center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    distance: Math.hypot(a.x - b.x, a.y - b.y),
  }
}

// M5 image stage with affine zoom/pan and progressive preview derivatives
export function ImageStage({ file, onError }: { file: FileRead; onError: () => void }) {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const activePointers = useRef(new Map<number, PointerPoint>())
  const lastPanPoint = useRef<PointerPoint | null>(null)
  const pinch = useRef<PinchState | null>(null)
  const lifetime = useRef(Symbol('image-stage'))
  const inFlightTier = useRef<InFlightTier | null>(null)
  const onErrorRef = useRef(onError)
  const hasLoadedAnyTier = useRef(false)
  const nativeImage = isBrowserNativeImage(file.relative_path)
  const metadataNaturalSize = metadataSize(file)
  const hasMetadataSize = metadataNaturalSize !== DEFAULT_SIZE
  const hasMetadataSizeRef = useRef(hasMetadataSize)
  const [background, setBackground] = useState<BackgroundMode>('dark')
  const [viewport, setViewport] = useState<Size>({ width: 0, height: 0 })
  const [naturalSize, setNaturalSize] = useState<Size>(() => metadataNaturalSize)
  const [fitMode, setFitMode] = useState<ImageFitMode>('fit')
  const [transform, setTransform] = useState<Transform>({ scale: 1, tx: 0, ty: 0 })
  const [displaySrc, setDisplaySrc] = useState(() => fileThumbnailUrl(file.bundle_id, file.id))
  const [loadedTier, setLoadedTier] = useState<SourceTier>('thumbnail')
  const [failedTiers, setFailedTiers] = useState<Set<SourceTier>>(() => new Set())

  const containScale = fitScale(viewport, naturalSize)
  const coverScale = fillScale(viewport, naturalSize)
  const modeTransform: Transform = {
    scale: scaleForMode(fitMode, viewport, naturalSize),
    tx: 0,
    ty: 0,
  }
  const renderedTransform =
    fitMode === 'custom' ? clampPan(transform, viewport, naturalSize) : modeTransform
  const wantedTier = useMemo(
    () => desiredTier(renderedTransform.scale, nativeImage),
    [renderedTransform.scale, nativeImage],
  )

  const sources = useMemo<TierSource[]>(() => {
    const out: TierSource[] = [
      { tier: 'thumbnail', src: fileThumbnailUrl(file.bundle_id, file.id) },
    ]
    if (!nativeImage) out.push({ tier: 'preview1600', src: filePreviewUrl(file, 1600) })
    if (!nativeImage) out.push({ tier: 'preview2560', src: filePreviewUrl(file, 2560) })
    if (nativeImage) out.push({ tier: 'original', src: fileContentUrl(file.id) })
    return out
  }, [file, nativeImage])

  const applyMode = useCallback(
    (mode: ImageFitMode) => {
      const scale = scaleForMode(mode, viewport, naturalSize)
      setFitMode(mode)
      setTransform({ scale, tx: 0, ty: 0 })
    },
    [naturalSize, viewport],
  )

  useEffect(() => {
    onErrorRef.current = onError
  }, [onError])

  useEffect(() => {
    const activeLifetime = Symbol('image-stage')
    lifetime.current = activeLifetime
    return () => {
      if (lifetime.current === activeLifetime) lifetime.current = Symbol('unmounted-image-stage')
      inFlightTier.current = null
    }
  }, [])

  useEffect(() => {
    const element = stageRef.current
    if (!element) return
    const update = () => {
      const rect = element.getBoundingClientRect()
      setViewport({ width: rect.width, height: rect.height })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const currentRank = SOURCE_TIER_RANK[loadedTier]
    const wantedRank = SOURCE_TIER_RANK[wantedTier]
    const next = sources.find(
      (source) =>
        SOURCE_TIER_RANK[source.tier] > currentRank &&
        SOURCE_TIER_RANK[source.tier] <= wantedRank &&
        !failedTiers.has(source.tier),
    )
    if (!next || inFlightTier.current) return
    const activeLifetime = lifetime.current
    inFlightTier.current = { tier: next.tier, lifetime: activeLifetime }
    decodeImage(next.src)
      .then((image) => {
        if (lifetime.current !== activeLifetime) return
        inFlightTier.current = null
        hasLoadedAnyTier.current = true
        if (!hasMetadataSizeRef.current && image.naturalWidth > 0 && image.naturalHeight > 0) {
          setNaturalSize({ width: image.naturalWidth, height: image.naturalHeight })
        }
        setDisplaySrc(next.src)
        setLoadedTier(next.tier)
      })
      .catch(() => {
        if (lifetime.current !== activeLifetime) return
        inFlightTier.current = null
        setFailedTiers((previous) => new Set(previous).add(next.tier))
      })
      .finally(() => {
        if (inFlightTier.current?.lifetime === activeLifetime) inFlightTier.current = null
      })
  }, [failedTiers, loadedTier, sources, wantedTier])

  const clamp = useCallback(
    (scale: number) => clampScale(scale, containScale, coverScale),
    [containScale, coverScale],
  )

  const boundTransform = useCallback(
    (next: Transform) => clampPan(next, viewport, naturalSize),
    [naturalSize, viewport],
  )

  const zoomAround = useCallback(
    (point: PointerPoint, scale: number) => {
      setFitMode('custom')
      setTransform(boundTransform(zoomToPoint(renderedTransform, clamp(scale), point)))
    },
    [boundTransform, clamp, renderedTransform],
  )

  const zoomFromCenter = useCallback(
    (factor: number) => {
      setFitMode('custom')
      setTransform(
        boundTransform(
          zoomToPoint(renderedTransform, clamp(renderedTransform.scale * factor), { x: 0, y: 0 }),
        ),
      )
    },
    [boundTransform, clamp, renderedTransform],
  )

  useEffect(() => {
    const root = stageRef.current?.closest<HTMLElement>('.media-viewer')
    if (!root) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (event.key === '0') applyMode('fit')
      else if (event.key === '1') applyMode('actual')
      else if (event.key === '+' || event.key === '=') zoomFromCenter(1.2)
      else if (event.key === '-' || event.key === '_') zoomFromCenter(1 / 1.2)
      else return
      event.preventDefault()
      event.stopPropagation()
    }
    root.addEventListener('keydown', onKeyDown, { capture: true })
    return () => root.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [applyMode, zoomFromCenter])

  useEffect(() => {
    const element = stageRef.current
    if (!element) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const factor = Math.exp(-event.deltaY * 0.0015)
      zoomAround(eventPoint(event, element), renderedTransform.scale * factor)
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [renderedTransform.scale, zoomAround])

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const element = stageRef.current
      if (!element || event.button !== 0) return
      element.focus()
      element.setPointerCapture(event.pointerId)
      const point = eventPoint(event, element)
      activePointers.current.set(event.pointerId, point)
      if (activePointers.current.size === 1) {
        lastPanPoint.current = point
        pinch.current = null
      } else if (activePointers.current.size === 2) {
        const geometry = pinchGeometry([...activePointers.current.values()])
        pinch.current = { ...geometry, transform: renderedTransform }
        lastPanPoint.current = null
      }
    },
    [renderedTransform],
  )

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const element = stageRef.current
      if (!element || !activePointers.current.has(event.pointerId)) return
      const point = eventPoint(event, element)
      activePointers.current.set(event.pointerId, point)
      if (activePointers.current.size >= 2 && pinch.current) {
        const geometry = pinchGeometry([...activePointers.current.values()].slice(0, 2))
        const scale = clamp(
          pinch.current.transform.scale * (geometry.distance / Math.max(1, pinch.current.distance)),
        )
        const centered = zoomToPoint(pinch.current.transform, scale, pinch.current.center)
        setFitMode('custom')
        setTransform(
          boundTransform({
            ...centered,
            tx: centered.tx + geometry.center.x - pinch.current.center.x,
            ty: centered.ty + geometry.center.y - pinch.current.center.y,
          }),
        )
        return
      }
      const previous = lastPanPoint.current
      if (!previous) return
      setFitMode('custom')
      setTransform((current) => {
        const base = fitMode === 'custom' ? current : renderedTransform
        return boundTransform({
          ...base,
          tx: base.tx + point.x - previous.x,
          ty: base.ty + point.y - previous.y,
        })
      })
      lastPanPoint.current = point
    },
    [boundTransform, clamp, fitMode, renderedTransform],
  )

  const finishPointer = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    activePointers.current.delete(event.pointerId)
    pinch.current = null
    lastPanPoint.current = activePointers.current.values().next().value ?? null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }, [])

  const cycleFit = useCallback(() => {
    applyMode(nextFitMode(fitMode))
  }, [applyMode, fitMode])

  const onImageLoad = useCallback(
    (event: React.SyntheticEvent<HTMLImageElement>) => {
      hasLoadedAnyTier.current = true
      const image = event.currentTarget
      if (!hasMetadataSize && image.naturalWidth > 0 && image.naturalHeight > 0) {
        setNaturalSize({ width: image.naturalWidth, height: image.naturalHeight })
      }
    },
    [hasMetadataSize],
  )

  const cycleBackground = () => {
    setBackground((value) => (value === 'dark' ? 'light' : value === 'light' ? 'checker' : 'dark'))
  }
  const zoomPercent = Math.round(renderedTransform.scale * 100)

  return (
    <div
      ref={stageRef}
      className={`mv-image-stage mv-image-stage--${background}`}
      tabIndex={-1}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishPointer}
      onPointerCancel={finishPointer}
      onDoubleClick={cycleFit}
      data-testid="image-stage"
    >
      <img
        className="mv-image"
        src={displaySrc}
        data-tier={loadedTier}
        alt={file.display_title}
        draggable={false}
        onLoad={onImageLoad}
        onError={() => {
          if (!hasLoadedAnyTier.current) onErrorRef.current()
        }}
        style={{
          width: `${naturalSize.width}px`,
          height: `${naturalSize.height}px`,
          transform: `translate(calc(-50% + ${renderedTransform.tx}px), calc(-50% + ${renderedTransform.ty}px)) scale(${renderedTransform.scale})`,
        }}
      />
      <div className="mv-image-tools">
        <button
          type="button"
          className="mv-icon mv-image-bg"
          aria-label="Toggle image background"
          title="Toggle image background"
          onClick={cycleBackground}
        >
          ◩
        </button>
        <span className="mv-zoom" data-testid="image-zoom">
          {zoomPercent}%
        </span>
      </div>
    </div>
  )
}

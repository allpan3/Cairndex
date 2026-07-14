import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type ReactNode,
} from 'react'

import { fileStoryboardUrl, fileStreamUrl } from '../api/client'
import { formatClock } from '../lib/format'
import { IconVolume, IconVolumeOff } from './icons'
import type { HoverPreviewSource } from './hoverPreviewState'
import { useHoverPreview } from './useHoverPreview'
import { StoryboardTile } from './viewer/player/StoryboardPreview'
import { cueForTime, type StoryboardCue } from './viewer/player/storyboardVtt'
import { useStoryboardCues } from './viewer/player/useStoryboardCues'

// Full card cover with one shared hover-preview behavior across browsing surfaces
export function HoverPreview({
  source,
  disabled = false,
  className,
  style,
  children,
}: {
  source: HoverPreviewSource | null
  disabled?: boolean
  className: string
  style?: CSSProperties
  children?: ReactNode
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const storyboardCuesRef = useRef<StoryboardCue[] | null>(null)
  const storyboardTimeForPosition = useCallback(
    (time: number) => cueForTime(storyboardCuesRef.current, time)?.cue.start ?? null,
    [],
  )
  const {
    active,
    phase,
    mode,
    muted,
    position,
    prefetchStoryboard,
    fallbackToStoryboard,
    giveUpStoryboard,
    toggleMuted,
    onTimeUpdate,
    bind,
  } = useHoverPreview(source, videoRef, disabled, storyboardTimeForPosition)
  const storyboardUrl = source?.mediaKind === 'video' ? fileStoryboardUrl(source.fileId) : null
  const prefetchedStoryboardUrl = prefetchStoryboard ? storyboardUrl : null
  const { data: cues, isFetched } = useStoryboardCues(prefetchedStoryboardUrl, true, false)
  useLayoutEffect(() => {
    storyboardCuesRef.current = cues ?? null
  }, [cues])
  const cue = useMemo(() => cueForTime(cues, position)?.cue ?? null, [cues, position])
  useEffect(() => {
    if (!active || mode !== 'storyboard' || !isFetched || cues) return
    // A missing or invalid storyboard ends this hover without retrying in a loop
    giveUpStoryboard()
  }, [active, cues, giveUpStoryboard, isFetched, mode])
  const mountDirect = active && mode === 'direct' && source !== null
  const showImage = active && mode === 'image' && source?.imageUrl
  const transitionMatchesCue = cue !== null && Math.abs(position - cue.start) < 0.001
  const showStoryboard =
    active &&
    storyboardUrl !== null &&
    cue !== null &&
    (mode === 'storyboard' ||
      phase === 'skimming' ||
      (phase === 'transitioning' && transitionMatchesCue))
  const hideDirectForTransition = mountDirect && phase === 'transitioning' && !showStoryboard
  const showChrome = mountDirect || showStoryboard
  const duration = source?.duration ?? 0
  const percent = duration > 0 ? Math.max(0, Math.min(100, (position / duration) * 100)) : 0

  return (
    <div
      className={`${className}${source ? ' hover-preview--media' : ''}`}
      style={style}
      data-hover-preview-state={active ? phase : 'inactive'}
      data-hover-preview-mode={mode}
      {...bind}
    >
      {children}
      {showImage && (
        <img
          className="hover-preview__image"
          data-testid="hover-preview-image"
          src={source.imageUrl ?? undefined}
          alt=""
        />
      )}
      {mountDirect && (
        <video
          ref={videoRef}
          className={`hover-preview__video${hideDirectForTransition ? ' hover-preview__video--sprite-hidden' : ''}`}
          data-testid="hover-preview-video"
          src={fileStreamUrl(source.fileId)}
          muted={muted}
          playsInline
          preload="metadata"
          disablePictureInPicture
          onTimeUpdate={onTimeUpdate}
          onError={fallbackToStoryboard}
        />
      )}
      {showStoryboard && (
        <StoryboardTile
          storyboardUrl={storyboardUrl}
          cue={cue}
          fill
          testId="hover-preview-storyboard"
        />
      )}
      {showChrome && (
        <div className="hover-preview__chrome">
          <div className="hover-preview__position" style={{ width: `${percent}%` }} />
          <div className="hover-preview__controls">
            {mountDirect && (
              <button
                type="button"
                className="hover-preview__sound"
                aria-label={muted ? 'Unmute preview' : 'Mute preview'}
                onClick={toggleMuted}
                onDoubleClick={(event) => event.stopPropagation()}
              >
                {muted ? <IconVolumeOff /> : <IconVolume />}
              </button>
            )}
            <div className="hover-preview__clock">{formatClock(position)}</div>
          </div>
        </div>
      )}
    </div>
  )
}

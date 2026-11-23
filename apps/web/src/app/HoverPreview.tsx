import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CatalogQueryContext } from '../api/catalogQuery'
import { fileStoryboardUrl, fileStreamUrl, getActiveLibraryId } from '../api/client'
import { replicaRequest } from '../api/replicas'
import { formatClock } from '../lib/format'
import { IconVolume, IconVolumeOff } from './icons'
import type { HoverPreviewSource } from './hoverPreviewState'
import { useHoverPreview } from './useHoverPreview'
import { StoryboardTile } from './viewer/player/StoryboardPreview'
import { cueForTime, type StoryboardCue } from './viewer/player/storyboardVtt'
import { useStoryboardCues } from './viewer/player/useStoryboardCues'

interface ProbedMediaFile {
  state?: string
  generation?: string | null
  storyboard_version?: string | null
  file?: {
    mime_type?: string | null
    relative_path?: string | null
    tech_metadata?: Record<string, unknown> | null
  }
  playback?: {
    progress?: {
      position_s?: number | null
      completed?: boolean
    } | null
  }
}

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
  const catalogLibrary = useContext(CatalogQueryContext)
  const [probeArmedFor, setProbeArmedFor] = useState<string | null>(null)
  const probeQuery = useQuery({
    queryKey: ['replica-media', catalogLibrary, 'hover-probe', source?.fileId],
    enabled:
      !disabled &&
      Boolean(
        catalogLibrary &&
        source?.mediaKind === 'video' &&
        source.needsProbe &&
        probeArmedFor === source.fileId,
      ),
    queryFn: ({ signal }) =>
      replicaRequest<ProbedMediaFile>(
        catalogLibrary!,
        `/media/files/${source!.fileId}`,
        'GET',
        undefined,
        signal,
      ),
    staleTime: 5 * 60_000,
    retry: false,
  })
  const effectiveSource = useMemo<HoverPreviewSource | null>(() => {
    if (!source || source.mediaKind !== 'video' || !source.needsProbe) return source
    const probed = probeQuery.data
    if (!probed || probed.state !== 'available') return source
    const meta = probed.file?.tech_metadata ?? {}
    const probedDuration = typeof meta.duration === 'number' ? meta.duration : 0
    if (probedDuration <= 0) return source
    const progress = probed.playback?.progress
    return {
      ...source,
      needsProbe: false,
      mimeType: probed.file?.mime_type ?? source.mimeType,
      relativePath: probed.file?.relative_path ?? source.relativePath,
      container: typeof meta.container === 'string' ? meta.container : source.container,
      videoCodec: typeof meta.video_codec === 'string' ? meta.video_codec : source.videoCodec,
      videoCodecTag:
        typeof meta.video_codec_tag === 'string' ? meta.video_codec_tag : source.videoCodecTag,
      audioCodec: typeof meta.audio_codec === 'string' ? meta.audio_codec : source.audioCodec,
      duration: probedDuration,
      startTime:
        progress && !progress.completed && progress.position_s
          ? progress.position_s
          : source.startTime,
      generation: probed.generation ?? source.generation,
      storyboardVersion: probed.storyboard_version ?? source.storyboardVersion,
    }
  }, [probeQuery.data, source])
  const {
    active,
    pointerInside,
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
  } = useHoverPreview(effectiveSource, videoRef, disabled, storyboardTimeForPosition)
  useEffect(() => {
    const fileId = source?.fileId
    if (disabled || !pointerInside || !source?.needsProbe || !catalogLibrary || !fileId) return
    const timer = window.setTimeout(() => setProbeArmedFor(fileId), 300)
    return () => window.clearTimeout(timer)
  }, [catalogLibrary, disabled, pointerInside, source?.fileId, source?.needsProbe])
  const storyboardUrl =
    effectiveSource?.mediaKind === 'video'
      ? fileStoryboardUrl(effectiveSource.fileId, effectiveSource.storyboardVersion ?? undefined)
      : null
  const prefetchedStoryboardUrl = prefetchStoryboard ? storyboardUrl : null
  const { data: cues, isFetched } = useStoryboardCues(prefetchedStoryboardUrl, true, false)
  useLayoutEffect(() => {
    storyboardCuesRef.current = cues ?? null
  }, [cues])
  const cue = useMemo(() => cueForTime(cues, position)?.cue ?? null, [cues, position])
  // A portable file has a storyboard only once something asks for it. v0.2.1's Update
  // made them all; here a hover asks for its own, as the viewer does, and loads it
  // when it is ready, so a rest after a skim shows the sprite instead of the cover.
  const client = useQueryClient()
  const library = getActiveLibraryId()
  const generation =
    effectiveSource?.mediaKind === 'video' ? (effectiveSource.generation ?? null) : null
  const requested = useQuery({
    queryKey: ['replica-media', library, 'storyboard', effectiveSource?.fileId, generation],
    enabled: active && isFetched && cues === null && Boolean(library && generation),
    queryFn: ({ signal }) =>
      replicaRequest<{ state: string }>(
        library!,
        `/media/files/${effectiveSource!.fileId}/storyboard`,
        'POST',
        { generation },
        signal,
      ),
    refetchInterval: (query) =>
      active && ['queued', 'running'].includes(query.state.data?.state ?? '') ? 1000 : false,
    retry: false,
  })
  const ready = requested.data?.state === 'ready'
  useEffect(() => {
    if (ready && prefetchedStoryboardUrl)
      void client.invalidateQueries({ queryKey: ['storyboard-vtt', prefetchedStoryboardUrl] })
  }, [client, prefetchedStoryboardUrl, ready])
  useEffect(() => {
    if (!active || mode !== 'storyboard' || !isFetched || cues) return
    // A missing or invalid storyboard ends this hover without retrying in a loop
    giveUpStoryboard()
  }, [active, cues, giveUpStoryboard, isFetched, mode])
  const mountDirect = active && mode === 'direct' && effectiveSource !== null
  const showImage = active && mode === 'image' && effectiveSource?.imageUrl
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
  const duration = effectiveSource?.duration ?? 0
  const percent = duration > 0 ? Math.max(0, Math.min(100, (position / duration) * 100)) : 0

  return (
    <div
      className={`${className}${effectiveSource ? ' hover-preview--media' : ''}`}
      style={style}
      data-hover-preview-state={active ? phase : 'inactive'}
      data-hover-preview-mode={mode}
      {...bind}
      onPointerLeave={() => {
        setProbeArmedFor(null)
        bind.onPointerLeave()
      }}
    >
      {children}
      {showImage && (
        <img
          className="hover-preview__image"
          data-testid="hover-preview-image"
          src={effectiveSource.imageUrl ?? undefined}
          alt=""
          draggable={false}
        />
      )}
      {mountDirect && (
        <video
          ref={videoRef}
          className={`hover-preview__video${hideDirectForTransition ? ' hover-preview__video--sprite-hidden' : ''}`}
          data-testid="hover-preview-video"
          src={fileStreamUrl(effectiveSource.fileId)}
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

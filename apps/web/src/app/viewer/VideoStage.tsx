import { useEffect, useMemo, useRef } from 'react'

import type { PlayableVideo } from '../../api/client'
import type { PlayerController } from './player/usePlayer'

interface VideoStageProps {
  video: PlayableVideo
  player: PlayerController
  videoRef: (element: HTMLVideoElement | null) => void
  title: string
  artworkUrl: string
  onError: () => void
  /** Left-click on the stage. The shell owns it so a click that merely dismissed
   *  the context menu does not also toggle playback. */
  onActivate: () => void
}

/** Direct-play video stage with native text tracks driven by custom controls. */
export function VideoStage({
  video,
  player,
  videoRef,
  title,
  artworkUrl,
  onError,
  onActivate,
}: VideoStageProps) {
  const trackRefs = useRef<Array<HTMLTrackElement | null>>([])
  const commandsRef = useRef<{
    play: () => void
    pause: () => void
    seek: (time: number) => void
    seekBy: (delta: number) => void
  }>({
    play: () => {},
    pause: () => {},
    seek: () => {},
    seekBy: () => {},
  })
  const withSrc = useMemo(() => video.subtitles.filter((track) => track.src), [video.subtitles])

  useEffect(() => {
    commandsRef.current = {
      play: player.play,
      pause: player.pause,
      seek: player.seek,
      seekBy: player.seekBy,
    }
  }, [player.pause, player.play, player.seek, player.seekBy])

  useEffect(() => {
    const defaultIndex = Math.max(
      0,
      withSrc.findIndex((track) => track.is_default),
    )
    const applyModes = () => {
      trackRefs.current.forEach((trackEl, index) => {
        if (!trackEl?.track) return
        trackEl.track.mode = player.subtitlesOn && index === defaultIndex ? 'showing' : 'disabled'
      })
    }
    applyModes()
    // Chromium's automatic track selection can flip a language-matched track
    // to 'showing' when its cues finish loading (after this effect already
    // ran), which stacks two subtitle languages — re-assert on each load.
    const els = trackRefs.current.filter((el): el is HTMLTrackElement => el !== null)
    els.forEach((el) => el.addEventListener('load', applyModes))
    return () => els.forEach((el) => el.removeEventListener('load', applyModes))
  }, [player.subtitlesOn, withSrc])

  useEffect(() => {
    if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return
    navigator.mediaSession.metadata = new MediaMetadata({
      title,
      // A File Browser path has no cover image, so it supplies no artwork rather
      // than an entry pointing at nothing.
      artwork: artworkUrl ? [{ src: artworkUrl, sizes: '512x512', type: 'image/jpeg' }] : [],
    })
    navigator.mediaSession.setActionHandler('play', () => commandsRef.current.play())
    navigator.mediaSession.setActionHandler('pause', () => commandsRef.current.pause())
    navigator.mediaSession.setActionHandler('seekbackward', () => commandsRef.current.seekBy(-10))
    navigator.mediaSession.setActionHandler('seekforward', () => commandsRef.current.seekBy(10))
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (typeof details.seekTime === 'number') commandsRef.current.seek(details.seekTime)
    })
    return () => {
      navigator.mediaSession.metadata = null
      navigator.mediaSession.setActionHandler('play', null)
      navigator.mediaSession.setActionHandler('pause', null)
      navigator.mediaSession.setActionHandler('seekbackward', null)
      navigator.mediaSession.setActionHandler('seekforward', null)
      navigator.mediaSession.setActionHandler('seekto', null)
    }
  }, [artworkUrl, title])

  return (
    <div className="mv-video-stage">
      <video
        ref={videoRef}
        className="mv-video"
        playsInline
        crossOrigin="anonymous"
        onError={onError}
        data-testid="media-video"
        // Left click is the primary play/pause gesture, matching every other
        // video player. Right click opens the viewer's own menu, handled by the
        // shell (plan 3 §7; seam reserved 2026-07-19, filled 2026-07-27).
        onClick={onActivate}
      >
        {withSrc.map((track, index) => (
          <track
            key={track.id}
            ref={(element) => {
              trackRefs.current[index] = element
            }}
            kind="subtitles"
            src={track.src ?? undefined}
            srcLang={track.language ?? undefined}
            label={track.label}
            default={track.is_default}
          />
        ))}
      </video>
    </div>
  )
}

import { useEffect } from 'react'

import type { PlayableVideo } from '../../api/client'
import type { PlayerController } from './player/usePlayer'

interface VideoStageProps {
  videoRef: React.RefObject<HTMLVideoElement | null>
  video: PlayableVideo
  player: PlayerController
  title: string
  artworkUrl: string
  onError: () => void
}

/** Direct-play video stage with native text tracks driven by custom controls. */
export function VideoStage({
  videoRef,
  video,
  player,
  title,
  artworkUrl,
  onError,
}: VideoStageProps) {
  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    const tracks = Array.from(el.textTracks)
    const firstEnabled =
      tracks.findIndex((track) => track.mode === 'showing') >= 0
        ? tracks.findIndex((track) => track.mode === 'showing')
        : tracks.findIndex((_, index) => video.subtitles[index]?.src)
    tracks.forEach((track, index) => {
      track.mode = player.subtitlesOn && index === firstEnabled ? 'showing' : 'disabled'
    })
  }, [player.subtitlesOn, video.subtitles, videoRef])

  useEffect(() => {
    if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return
    navigator.mediaSession.metadata = new MediaMetadata({
      title,
      artwork: [{ src: artworkUrl, sizes: '512x512', type: 'image/jpeg' }],
    })
    navigator.mediaSession.setActionHandler('play', player.play)
    navigator.mediaSession.setActionHandler('pause', player.pause)
    navigator.mediaSession.setActionHandler('seekbackward', () => player.seekBy(-10))
    navigator.mediaSession.setActionHandler('seekforward', () => player.seekBy(10))
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (typeof details.seekTime === 'number') player.seek(details.seekTime)
    })
    return () => {
      navigator.mediaSession.metadata = null
      navigator.mediaSession.setActionHandler('play', null)
      navigator.mediaSession.setActionHandler('pause', null)
      navigator.mediaSession.setActionHandler('seekbackward', null)
      navigator.mediaSession.setActionHandler('seekforward', null)
      navigator.mediaSession.setActionHandler('seekto', null)
    }
  }, [artworkUrl, player, title])

  return (
    <div className="mv-video-stage">
      <video
        ref={videoRef}
        className="mv-video"
        playsInline
        crossOrigin="anonymous"
        onError={onError}
        data-testid="media-video"
      >
        {video.subtitles
          .filter((track) => track.src)
          .map((track) => (
            <track
              key={track.id}
              kind="subtitles"
              src={track.src ?? undefined}
              srcLang={track.language ?? undefined}
              label={track.label}
              default={track.is_default}
            />
          ))}
      </video>
      {player.status !== 'playing' && (
        <button className="mv-center-play" onClick={player.playPause} aria-label="Play">
          ▶
        </button>
      )}
    </div>
  )
}

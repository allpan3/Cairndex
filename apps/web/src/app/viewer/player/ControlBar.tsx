import { useLayoutEffect, useRef } from 'react'

import type { Moment, PlayableVideo, SubtitleTrackRead } from '../../../api/client'
import {
  IconCamera,
  IconCaptions,
  IconClipRange,
  IconFullscreen,
  IconMoment,
  IconPause,
  IconPictureInPicture,
  IconPlay,
  IconVolume,
  IconVolumeOff,
} from '../../icons'
import { formatClock } from '../../../lib/format'
import { ClipBar } from './ClipBar'
import { SeekBar } from './SeekBar'
import { SettingsMenu } from './SettingsMenu'
import type { ClipRangeController } from './useClipRange'
import type { HlsSessionState } from './useHlsSession'
import type { PlayerController } from './usePlayer'

interface ControlBarProps {
  player: PlayerController
  video: PlayableVideo
  subtitles: SubtitleTrackRead[]
  hls: HlsSessionState
  onSnapshot: () => void
  onDragChange: (dragging: boolean) => void
  fileLoop: boolean
  onFileLoop: (enabled: boolean) => void
  /** Absent for a source with no clip support (an unindexed path). */
  clip?: ClipRangeController
  onExportClip?: () => void
  maxExportSeconds?: number
  /** Saved moments on this file, drawn on the seek track (plan 7). */
  moments?: Moment[]
  /** Mark a moment at the playhead, or save the marked span if there is one. */
  onSaveMoment?: () => void
}

/** Desktop-style custom video controls for direct and HLS playback. */
export function ControlBar({
  player,
  video,
  subtitles,
  hls,
  onSnapshot,
  onDragChange,
  fileLoop,
  onFileLoop,
  clip,
  onExportClip,
  maxExportSeconds,
  moments,
  onSaveMoment,
}: ControlBarProps) {
  const time = `${formatClock(player.currentTime)} / ${formatClock(player.duration)}`
  const hasSubtitles = subtitles.some((track) => track.src)

  // Publish where the seek track starts, measured rather than guessed. The
  // resume toast is *about* the playhead, so "near the controls" means near the
  // track — and the track is the bottom strip of this bar, under the button
  // row, so anchoring to the bar's top left the toast 52px from the thing it
  // refers to (owner, 2026-07-27). A literal would also be wrong the moment the
  // row wrapped or the font differed.
  const barRef = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const bar = barRef.current
    if (!bar) return
    const viewer = bar.closest<HTMLElement>('.media-viewer')
    if (!viewer) return
    const publish = () => {
      const barRect = bar.getBoundingClientRect()
      const track = bar.querySelector('.mv-seek')
      const trackTop = track?.getBoundingClientRect().top ?? barRect.top
      viewer.style.setProperty(
        '--mv-seek-top',
        `${Math.max(0, Math.round(window.innerHeight - trackTop))}px`,
      )
    }
    publish()
    const observer = new ResizeObserver(publish)
    observer.observe(bar)
    window.addEventListener('resize', publish)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', publish)
      viewer.style.removeProperty('--mv-seek-top')
    }
  }, [])

  return (
    <div className="mv-controls" data-testid="media-controls" ref={barRef}>
      {clip && (
        <ClipBar
          clip={clip}
          player={player}
          onExport={onExportClip}
          maxExportSeconds={maxExportSeconds}
          onSaveMoment={onSaveMoment}
        />
      )}
      <div className="mv-controls__row">
        <button
          className="mv-btn mv-btn--primary"
          onClick={player.playPause}
          aria-label={player.status === 'playing' ? 'Pause' : 'Play'}
          title={player.status === 'playing' ? 'Pause' : 'Play'}
        >
          {player.status === 'playing' ? <IconPause /> : <IconPlay />}
        </button>
        <span className="mv-time">{time}</span>
        <div className="mv-controls__spacer" />
        <button
          className="mv-btn"
          onClick={() => player.setMuted(!player.muted)}
          aria-label={player.muted ? 'Unmute' : 'Mute'}
          title={player.muted ? 'Unmute' : 'Mute'}
        >
          {player.muted ? <IconVolumeOff /> : <IconVolume />}
        </button>
        <input
          className="mv-volume"
          aria-label="Volume"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={player.muted ? 0 : player.volume}
          onChange={(event) => player.setVolume(Number(event.currentTarget.value))}
        />
        <button
          className={`mv-btn${player.subtitlesOn ? ' is-active' : ''}`}
          onClick={player.toggleSubtitles}
          aria-label={player.subtitlesOn ? 'Hide subtitles' : 'Show subtitles'}
          aria-pressed={player.subtitlesOn}
          title={hasSubtitles ? 'Subtitles' : 'No subtitles'}
          disabled={!hasSubtitles}
        >
          <IconCaptions />
        </button>
        <button className="mv-btn" onClick={onSnapshot} aria-label="Snapshot" title="Snapshot">
          <IconCamera />
        </button>
        {clip && (
          <button
            className={`mv-btn${clip.active ? ' is-active' : ''}`}
            onClick={() => (clip.active ? clip.close() : clip.open())}
            aria-label={clip.active ? 'Close range' : 'Mark range'}
            aria-pressed={clip.active}
            title="Range ([ and ] mark the ends)"
          >
            <IconClipRange />
          </button>
        )}
        {onSaveMoment && (
          <button
            className="mv-btn"
            onClick={onSaveMoment}
            aria-label="Save moment"
            title="Save a moment here (B). With a range marked, saves the range."
          >
            <IconMoment />
          </button>
        )}
        <SettingsMenu
          hls={hls}
          subtitles={subtitles}
          player={player}
          fileLoop={fileLoop}
          onFileLoop={onFileLoop}
          sourceHeight={video.height}
          clip={clip}
        />
        <button
          className={`mv-btn${player.pip ? ' is-active' : ''}`}
          onClick={player.togglePiP}
          aria-label="Picture in Picture"
          title="Picture in Picture"
        >
          <IconPictureInPicture />
        </button>
        <button
          className={`mv-btn${player.fullscreen ? ' is-active' : ''}`}
          onClick={player.toggleFullscreen}
          aria-label={player.fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          title={player.fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        >
          <IconFullscreen />
        </button>
      </div>
      <SeekBar
        player={player}
        video={video}
        onDragChange={onDragChange}
        clip={clip}
        moments={moments}
      />
    </div>
  )
}

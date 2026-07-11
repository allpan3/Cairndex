import type { PlayableVideo, SubtitleTrackRead } from '../../../api/client'
import {
  IconCamera,
  IconCaptions,
  IconFullscreen,
  IconPause,
  IconPictureInPicture,
  IconPlay,
  IconVolume,
  IconVolumeOff,
} from '../../icons'
import { formatClock } from '../../../lib/format'
import { SeekBar } from './SeekBar'
import { SettingsMenu } from './SettingsMenu'
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
  onUseCoverFrame: () => void
  onClearCoverFrame: () => void
  hasCoverFrame: boolean
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
  onUseCoverFrame,
  onClearCoverFrame,
  hasCoverFrame,
}: ControlBarProps) {
  const time = `${formatClock(player.currentTime)} / ${formatClock(player.duration)}`
  const hasSubtitles = subtitles.some((track) => track.src)
  return (
    <div className="mv-controls" data-testid="media-controls">
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
        <SettingsMenu
          hls={hls}
          subtitles={subtitles}
          player={player}
          fileLoop={fileLoop}
          onFileLoop={onFileLoop}
          onUseCoverFrame={onUseCoverFrame}
          onClearCoverFrame={onClearCoverFrame}
          hasCoverFrame={hasCoverFrame}
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
      <SeekBar player={player} video={video} onDragChange={onDragChange} />
    </div>
  )
}

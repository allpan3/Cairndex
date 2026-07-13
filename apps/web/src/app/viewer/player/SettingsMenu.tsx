import { useEffect, useRef, useState } from 'react'

import type { AudioStreamRead, SubtitleTrackRead } from '../../../api/client'
import { PLAYER_SEEK_STEPS } from '../../types'
import { IconSettings } from '../../icons'
import { qualityOptions } from './quality'
import type { HlsSessionState } from './useHlsSession'
import type { PlayerController } from './usePlayer'

/** Map the slider's linear stop index to the supported seek-step values. */
function seekStepAt(index: number): (typeof PLAYER_SEEK_STEPS)[number] {
  return PLAYER_SEEK_STEPS[index] ?? 5
}

interface SettingsMenuProps {
  hls: HlsSessionState
  subtitles: SubtitleTrackRead[]
  player: PlayerController
  fileLoop: boolean
  onFileLoop: (enabled: boolean) => void
  onUseCoverFrame: () => void
  onClearCoverFrame: () => void
  hasCoverFrame: boolean
  sourceHeight: number | null
}

function audioLabel(track: AudioStreamRead): string {
  const parts: string[] = []
  if (track.title) parts.push(track.title)
  else if (track.language) parts.push(track.language)
  else parts.push(track.index !== null ? `Track ${track.index}` : 'Track')
  if (track.channels === 2) parts.push('Stereo')
  else if (track.channels === 6) parts.push('5.1')
  else if (track.channels === 8) parts.push('7.1')
  else if (track.channels) parts.push(`${track.channels}ch`)
  if (track.codec) parts.push(track.codec.toUpperCase())
  return parts.join(' · ')
}

/**
 * Quality / audio-track / subtitle burn-in menu (plan 1 §6.3 milestone table).
 * Each choice re-decides and starts a new session at the current playhead;
 * audio and burn-in only appear when the current stream can offer them.
 */
export function SettingsMenu({
  hls,
  subtitles,
  player,
  fileLoop,
  onFileLoop,
  onUseCoverFrame,
  onClearCoverFrame,
  hasCoverFrame,
  sourceHeight,
}: SettingsMenuProps) {
  const [open, setOpen] = useState(false)
  const [resolutionOpen, setResolutionOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  // Only non-native tracks (embedded/bitmap, no servable VTT) are burn-in
  // candidates; native text tracks already render as `<track>` overlays.
  const burnable = subtitles.filter((track) => !track.src)
  const audioTracks = hls.audioStreams
  const defaultAudio = audioTracks.find((s) => s.default)?.index ?? audioTracks[0]?.index ?? null
  const selectedAudio = hls.params.audioStreamIndex ?? defaultAudio
  const resolutions = qualityOptions(sourceHeight)
  const selectedResolution = resolutions.find((item) => item.value === hls.params.maxHeight)

  return (
    <div className="mv-settings" ref={ref}>
      <button
        className={`mv-btn${open ? ' is-active' : ''}`}
        onClick={() => setOpen((value) => !value)}
        aria-label="Playback settings"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Settings"
      >
        <IconSettings />
      </button>
      {open && (
        <div className="mv-menu" role="menu" data-testid="settings-menu">
          <div className="mv-menu__group">
            <label className="mv-menu__slider-label" htmlFor="mv-seek-step">
              <span>Seek step</span>
              <output>{player.seekStep} s</output>
            </label>
            <input
              id="mv-seek-step"
              className="mv-menu__slider"
              type="range"
              min={0}
              max={PLAYER_SEEK_STEPS.length - 1}
              step={1}
              value={PLAYER_SEEK_STEPS.indexOf(player.seekStep)}
              aria-label="Seek step"
              aria-valuetext={`${player.seekStep} seconds`}
              onChange={(event) =>
                player.setSeekStep(seekStepAt(Number(event.currentTarget.value)))
              }
            />
          </div>

          <div className="mv-menu__group">
            <label className="mv-menu__slider-label" htmlFor="mv-playback-speed">
              <span>Speed</span>
              <output>{player.rate}×</output>
            </label>
            <input
              id="mv-playback-speed"
              className="mv-menu__slider"
              type="range"
              min={0.25}
              max={3}
              step={0.25}
              value={player.rate}
              aria-label="Playback speed"
              aria-valuetext={`${player.rate} times`}
              onChange={(event) => player.setRate(Number(event.currentTarget.value))}
            />
            <button
              role="menuitemcheckbox"
              aria-checked={player.preservesPitch}
              className={`mv-menu__item${player.preservesPitch ? ' is-selected' : ''}`}
              onClick={() => player.setPreservesPitch(!player.preservesPitch)}
            >
              Preserve pitch
            </button>
          </div>

          <div className="mv-menu__group">
            <div className="mv-menu__label">Playback</div>
            <button
              role="menuitemcheckbox"
              aria-checked={fileLoop}
              className={`mv-menu__item${fileLoop ? ' is-selected' : ''}`}
              onClick={() => onFileLoop(!fileLoop)}
            >
              Loop file
            </button>
          </div>

          <div
            className={`mv-menu__group mv-menu__group--resolution${resolutionOpen ? ' is-open' : ''}`}
          >
            <button
              className={`mv-menu__submenu-toggle${resolutionOpen ? ' is-open' : ''}`}
              role="menuitem"
              aria-expanded={resolutionOpen}
              onClick={() => setResolutionOpen((value) => !value)}
            >
              <span>Resolution</span>
              <span>
                {selectedResolution?.label ?? 'Auto'} {resolutionOpen ? '▾' : '›'}
              </span>
            </button>
            {resolutionOpen && (
              <div className="mv-menu__submenu">
                {resolutions.map((quality) => (
                  <button
                    key={quality.label}
                    role="menuitemradio"
                    aria-checked={hls.params.maxHeight === quality.value}
                    className={`mv-menu__item${hls.params.maxHeight === quality.value ? ' is-selected' : ''}`}
                    onClick={() => hls.setParam('maxHeight', quality.value)}
                  >
                    {quality.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {audioTracks.length > 1 && (
            <div className="mv-menu__group">
              <div className="mv-menu__label">Audio</div>
              {audioTracks.map((track) => (
                <button
                  key={track.index ?? audioLabel(track)}
                  role="menuitemradio"
                  aria-checked={selectedAudio === track.index}
                  className={`mv-menu__item${selectedAudio === track.index ? ' is-selected' : ''}`}
                  onClick={() =>
                    track.index !== null && hls.setParam('audioStreamIndex', track.index)
                  }
                  disabled={track.index === null}
                >
                  {audioLabel(track)}
                </button>
              ))}
            </div>
          )}

          {burnable.length > 0 && (
            <div className="mv-menu__group">
              <div className="mv-menu__label">Burn in subtitles</div>
              <button
                role="menuitemradio"
                aria-checked={hls.params.burnSubtitleTrackId === null}
                className={`mv-menu__item${hls.params.burnSubtitleTrackId === null ? ' is-selected' : ''}`}
                onClick={() => hls.setParam('burnSubtitleTrackId', null)}
              >
                Off
              </button>
              {burnable.map((track) => (
                <button
                  key={track.id}
                  role="menuitemradio"
                  aria-checked={hls.params.burnSubtitleTrackId === track.id}
                  className={`mv-menu__item${hls.params.burnSubtitleTrackId === track.id ? ' is-selected' : ''}`}
                  onClick={() => hls.setParam('burnSubtitleTrackId', track.id)}
                >
                  {track.label}
                </button>
              ))}
            </div>
          )}
          <div className="mv-menu__group">
            <div className="mv-menu__label">Cover</div>
            <div className="mv-menu__actions">
              <button className="mv-menu__action" role="menuitem" onClick={onUseCoverFrame}>
                Set frame as cover
              </button>
              <button
                className="mv-menu__action"
                role="menuitem"
                onClick={onClearCoverFrame}
                disabled={!hasCoverFrame}
              >
                Reset cover to default
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

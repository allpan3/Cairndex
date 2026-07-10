import { useEffect, useRef, useState } from 'react'

import type { AudioStreamRead, SubtitleTrackRead } from '../../../api/client'
import { IconSettings } from '../../icons'
import type { HlsSessionState } from './useHlsSession'

// Height ladder for the quality menu. Auto (null) lets the client decode the
// source as-is; picking a cap forces the server to transcode down to it. In-
// stream ABR is out of scope — each choice is a fresh decision + session (§6.3).
const QUALITY_LADDER: Array<{ label: string; value: number | null }> = [
  { label: 'Auto', value: null },
  { label: '1080p', value: 1080 },
  { label: '720p', value: 720 },
  { label: '480p', value: 480 },
]

interface SettingsMenuProps {
  hls: HlsSessionState
  subtitles: SubtitleTrackRead[]
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
export function SettingsMenu({ hls, subtitles }: SettingsMenuProps) {
  const [open, setOpen] = useState(false)
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
            <div className="mv-menu__label">Quality</div>
            {QUALITY_LADDER.map((quality) => (
              <button
                key={quality.label}
                role="menuitemradio"
                aria-checked={hls.params.maxHeight === quality.value}
                className={`mv-menu__item${hls.params.maxHeight === quality.value ? ' is-selected' : ''}`}
                onClick={() => hls.setMaxHeight(quality.value)}
              >
                {quality.label}
              </button>
            ))}
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
                  onClick={() => track.index !== null && hls.setAudioStream(track.index)}
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
                onClick={() => hls.setBurnSubtitle(null)}
              >
                Off
              </button>
              {burnable.map((track) => (
                <button
                  key={track.id}
                  role="menuitemradio"
                  aria-checked={hls.params.burnSubtitleTrackId === track.id}
                  className={`mv-menu__item${hls.params.burnSubtitleTrackId === track.id ? ' is-selected' : ''}`}
                  onClick={() => hls.setBurnSubtitle(track.id)}
                >
                  {track.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

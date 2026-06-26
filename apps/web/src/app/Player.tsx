import { useState } from 'react'

import type { PlayableVideo } from '../api/client'
import { usePlaybackManifest } from '../api/hooks'

/**
 * Direct-playback modal. Lists a bundle's videos, plays the chosen one through
 * the range-streamed `stream_url`, and attaches WebVTT subtitle tracks. When a
 * video isn't browser-playable (e.g. MKV/HEVC) we show the server's reason and
 * a fallback note instead of a silent black box (AGENTS.md §6.1).
 */
export function Player({ bundleId, onClose }: { bundleId: string; onClose: () => void }) {
  const { data, isLoading } = usePlaybackManifest(bundleId)
  const videos = data?.videos ?? []
  const [index, setIndex] = useState(0)
  const current: PlayableVideo | undefined = videos[index]

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal modal--player"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="modal__head">
          <h2>{current?.display_title ?? 'Play'}</h2>
          <button className="modal__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {isLoading && <div className="state">Loading…</div>}
        {!isLoading && videos.length === 0 && (
          <div className="state">This bundle has no video files to play.</div>
        )}

        {current && (
          <>
            {current.playable ? (
              <video
                className="player__video"
                key={current.file_id}
                src={current.stream_url}
                controls
                autoPlay
                crossOrigin="anonymous"
              >
                {current.subtitles
                  .filter((t) => t.src)
                  .map((t) => (
                    <track
                      key={t.id}
                      kind="subtitles"
                      src={t.src ?? undefined}
                      srcLang={t.language ?? undefined}
                      label={t.label}
                      default={t.is_default}
                    />
                  ))}
              </video>
            ) : (
              <div className="player__fallback" role="alert">
                <div className="player__fallback-icon">⚠</div>
                <div>
                  <strong>Can’t play this in the browser.</strong>
                  <p>{current.reason}</p>
                  <p className="player__fallback-hint">
                    Transcoded playback for unsupported formats is a later milestone.
                  </p>
                </div>
              </div>
            )}

            {current.subtitles.length > 0 && (
              <div className="player__subs">
                Subtitles: {current.subtitles.map((t) => t.label).join(', ') || 'none'}
              </div>
            )}
          </>
        )}

        {videos.length > 1 && (
          <div className="player__playlist">
            {videos.map((v, i) => (
              <button
                key={v.file_id}
                className={`player__item${i === index ? ' is-active' : ''}`}
                onClick={() => setIndex(i)}
              >
                {v.display_title}
                {!v.playable && <span className="player__badge">!</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

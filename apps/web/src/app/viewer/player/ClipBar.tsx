import { ClipTimeline } from './ClipTimeline'
import { formatClipTime, rangeDuration, type ClipEdge } from './clipRange'
import type { ClipRangeController } from './useClipRange'
import type { PlayerController } from './usePlayer'

/**
 * The range picker, docked above the seek bar (plan 1 §10 / M11).
 *
 * Inline rather than in a dialog on purpose: setting an in-point accurately
 * means watching the frame you land on, and a modal over the viewer hides the
 * one thing you are looking at. The export dialog that follows only asks for
 * format options, with the range already decided here.
 */

/** A coarse step alongside the frame step, for getting close quickly. */
const COARSE_NUDGE_SECONDS = 1

/** The key that plays the span, next to the `[` and `]` that mark its ends. */
export const PLAY_RANGE_KEY = '\\'

/** The key that saves a moment — `b` for bookmark, and otherwise unbound. */
export const SAVE_MOMENT_KEY = 'b'

interface ClipBarProps {
  clip: ClipRangeController
  player: PlayerController
  /** Opens the export dialog; absent when this file cannot be exported. */
  onExport?: () => void
  /** Longest span the exporter accepts, for the over-length warning. */
  maxExportSeconds?: number
  /**
   * Saves the marked span as a moment (plan 7); absent when this file
   * cannot hold one — an unindexed File Browser path has no row to hang it on.
   */
  onSaveMoment?: () => void
}

function EdgeRow({
  clip,
  edge,
  label,
}: {
  clip: ClipRangeController
  edge: ClipEdge
  label: string
}) {
  const range = clip.range
  if (!range) return null
  const frameLabel = `${edge === 'start' ? 'start' : 'end'} by one frame`
  const setLabel = edge === 'start' ? 'Set In' : 'Set Out'
  return (
    <div className="mv-clip__row">
      <span className="mv-clip__label">{label}</span>
      <div className="mv-clip__nudge" role="group" aria-label={`Adjust clip ${edge}`}>
        <button
          className="mv-clip__step"
          onClick={() => clip.nudge(edge, -COARSE_NUDGE_SECONDS)}
          aria-label={`Move ${edge} back one second`}
          title="−1 s"
        >
          ◀◀
        </button>
        <button
          className="mv-clip__step"
          onClick={() => clip.nudge(edge, -clip.frame)}
          aria-label={`Move ${frameLabel} back`}
          title="−1 frame"
        >
          ◀
        </button>
        <output className="mv-clip__time">{formatClipTime(range[edge])}</output>
        <button
          className="mv-clip__step"
          onClick={() => clip.nudge(edge, clip.frame)}
          aria-label={`Move ${frameLabel} forward`}
          title="+1 frame"
        >
          ▶
        </button>
        <button
          className="mv-clip__step"
          onClick={() => clip.nudge(edge, COARSE_NUDGE_SECONDS)}
          aria-label={`Move ${edge} forward one second`}
          title="+1 s"
        >
          ▶▶
        </button>
      </div>
      <button
        className="mv-clip__here"
        onClick={() => clip.markAtPlayhead(edge)}
        // The visible text is inside the accessible name, so speech control
        // ("click set beginning") reaches the same button a pointer does.
        aria-label={`${setLabel} at the playhead`}
        title={`${setLabel} at the playhead (${edge === 'start' ? '[' : ']'}). Past the other end, the whole clip moves and keeps its length.`}
      >
        {setLabel}
      </button>
    </div>
  )
}

export function ClipBar({ clip, player, onExport, maxExportSeconds, onSaveMoment }: ClipBarProps) {
  const range = clip.range
  if (!clip.active || !range) return null

  const length = rangeDuration(range)
  const tooLong = maxExportSeconds !== undefined && length > maxExportSeconds

  return (
    <div className="mv-clip" data-testid="clip-bar">
      {/* In and Out sit together on the left, so the two numbers being compared
          are adjacent while adjusting. The label and the actions take the space
          beside them rather than a fourth row of their own. */}
      <div className="mv-clip__edges">
        <EdgeRow clip={clip} edge="start" label="In" />
        <EdgeRow clip={clip} edge="end" label="Out" />
      </div>

      <div className="mv-clip__side">
        <div className="mv-clip__meta">
          <span className="mv-clip__title">Range</span>
          {/* The length, plainly. It used to turn red beside a "max 30 s" notice
              once the span passed what a GIF may be — which read as a limit on
              the *range*, and there is none: a moment can be any length, and
              only the export is bounded (owner, 2026-08-30). The greyed-out
              Save GIF button and its tooltip say that, where it applies. */}
          <span className="mv-clip__duration">{length.toFixed(2)} s</span>
          {/* Top right, away from the actions: closing the picker is not one of
              the things you do *to* a range (owner, 2026-08-30). */}
          <button className="mv-clip__close" onClick={clip.close} aria-label="Close range">
            ✕
          </button>
        </div>
        {/* Two rows on this side, matching the two on the left, with this one
            sitting on the same baseline as Out. The actions had been wrapping to
            a third row, which is what put Save GIF below Save Moment instead of
            after it. */}
        <div className="mv-clip__buttons">
          {/* One control, not two. "From In" and "Range" were an action and a
              mode that only ever made sense together, and separating them left
              a strip too crowded to read (owner, 2026-08-16). */}
          <button
            className={`mv-clip__play${clip.playingRange ? ' is-active' : ''}`}
            onClick={clip.playRange}
            aria-label="Play range"
            title={`Play the span from In and stop at Out (${PLAY_RANGE_KEY})`}
          >
            ▶ Play Range
          </button>
          {/* The range loop, armed (plan 7). No longer a modifier on Play Range:
              while it is lit, all playback stays inside the span and repeats,
              and a pause does not end it — so this is both the sign the mode is
              on and the one click that ends it. */}
          <button
            className={`mv-clip__toggle${clip.loop ? ' is-active' : ''}`}
            onClick={() => clip.setLoop(!clip.loop)}
            aria-pressed={clip.loop}
            // Stable label, state on `aria-pressed`: a toggle whose *name*
            // changes reads to a screen reader as a different control appearing.
            aria-label="Range loop"
            title={
              clip.loop
                ? 'Range loop is on. Click to stop confining playback to this span.'
                : 'Range loop: playback stays inside this span and repeats until you turn this off.'
            }
          >
            ⟳ Loop
          </button>
          {onSaveMoment && (
            <button
              className="mv-clip__save"
              onClick={onSaveMoment}
              title={`Save the marked span as a moment (${SAVE_MOMENT_KEY.toUpperCase()})`}
            >
              ★ Save Moment
            </button>
          )}
          {onExport && (
            <button
              className="mv-clip__export"
              onClick={onExport}
              disabled={tooLong}
              title={
                tooLong
                  ? `A clip may be at most ${maxExportSeconds} seconds — shorten it to export.`
                  : 'Encode the marked span as a GIF'
              }
            >
              Save GIF…
            </button>
          )}
        </div>
      </div>

      <ClipTimeline clip={clip} player={player} />
    </div>
  )
}

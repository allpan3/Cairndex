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

interface ClipBarProps {
  clip: ClipRangeController
  player: PlayerController
  /** Opens the export dialog; absent when this file cannot be exported. */
  onExport?: () => void
  /** Longest span the exporter accepts, for the over-length warning. */
  maxExportSeconds?: number
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
          ⏪
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
          ⏩
        </button>
      </div>
      <button
        className="mv-clip__here"
        onClick={() => clip.markAtPlayhead(edge)}
        aria-label={`Set clip ${edge} to the playhead`}
        title={`Set ${edge} here (${edge === 'start' ? '[' : ']'})`}
      >
        Set here
      </button>
    </div>
  )
}

export function ClipBar({ clip, player, onExport, maxExportSeconds }: ClipBarProps) {
  const range = clip.range
  if (!clip.active || !range) return null

  const length = rangeDuration(range)
  const tooLong = maxExportSeconds !== undefined && length > maxExportSeconds

  return (
    <div className="mv-clip" data-testid="clip-bar">
      <div className="mv-clip__head">
        <span className="mv-clip__title">Clip</span>
        <span className={`mv-clip__duration${tooLong ? ' is-over' : ''}`}>
          {length.toFixed(2)} s
        </span>
        {tooLong && (
          <span className="mv-clip__warn" role="status">
            Longer than the {maxExportSeconds} s limit — shorten it to export.
          </span>
        )}
        <div className="mv-clip__spacer" />
        <button
          className={`mv-clip__toggle${clip.loop ? ' is-active' : ''}`}
          onClick={() => clip.setLoop(!clip.loop)}
          aria-pressed={clip.loop}
          title="Repeat the marked span while picking it"
        >
          ⟳ Loop
        </button>
        {onExport && (
          <button className="mv-clip__export" onClick={onExport} disabled={tooLong}>
            Save GIF…
          </button>
        )}
        <button className="mv-clip__close" onClick={clip.close} aria-label="Close clip range">
          ✕
        </button>
      </div>

      <EdgeRow clip={clip} edge="start" label="In" />
      <EdgeRow clip={clip} edge="end" label="Out" />
      <ClipTimeline clip={clip} player={player} />
    </div>
  )
}

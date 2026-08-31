import { useEffect, useId, useMemo } from 'react'

import { cueForTime, storyboardSheetUrl, type StoryboardCue } from './storyboardVtt'
import { useStoryboardCues } from './useStoryboardCues'

const MAX_PREVIEW_WIDTH = 320
const MAX_PREVIEW_HEIGHT = 240
const SHEET_COLUMNS = 5
const SHEET_ROWS = 5

// Props needed to load and crop an optional storyboard tile
interface StoryboardPreviewProps {
  storyboardUrl: string | null
  time: number
}

// Render one cropped sprite tile for seek tooltips or a cover-filling card
export function StoryboardTile({
  storyboardUrl,
  cue,
  fill = false,
  fillClassName = 'hover-preview__storyboard',
  testId,
}: {
  storyboardUrl: string
  cue: StoryboardCue
  fill?: boolean
  /**
   * The class a filling tile wears, and with it the *positioning* it inherits.
   *
   * Named by the caller rather than hard-coded, because "fill" is only half a
   * contract: the hover preview's class is `position: absolute; inset: 0`, which
   * fills a positioned card and — anywhere without one — escapes to the viewport
   * instead. A moment row borrowed this and drew a full-window frame over the
   * whole app (owner-reported, 2026-08-29). A second consumer must bring its own
   * class so it brings its own containing block with it.
   */
  fillClassName?: string
  testId?: string
}) {
  const clipId = `storyboard-tile-${useId().replaceAll(':', '')}`

  if (fill) {
    return (
      <svg
        className={fillClassName}
        data-testid={testId}
        data-cue-position={`${cue.x},${cue.y}`}
        data-cue-start={cue.start}
        viewBox={`0 0 ${cue.w} ${cue.h}`}
        preserveAspectRatio="xMidYMid meet"
        aria-hidden="true"
      >
        <defs>
          <clipPath id={clipId}>
            <rect width={cue.w} height={cue.h} />
          </clipPath>
        </defs>
        <g clipPath={`url(#${clipId})`}>
          <image
            href={storyboardSheetUrl(storyboardUrl, cue.url)}
            x={-cue.x}
            y={-cue.y}
            width={cue.w * SHEET_COLUMNS}
            height={cue.h * SHEET_ROWS}
            preserveAspectRatio="none"
          />
        </g>
      </svg>
    )
  }

  const scale = Math.min(1, MAX_PREVIEW_WIDTH / cue.w, MAX_PREVIEW_HEIGHT / cue.h)
  const width = Math.round(cue.w * scale)
  const height = Math.round(cue.h * scale)
  const sheetWidth = cue.w * SHEET_COLUMNS * scale
  const sheetHeight = cue.h * SHEET_ROWS * scale

  return (
    <div
      className="mv-storyboard-preview"
      data-testid={testId}
      style={{
        width,
        height,
        backgroundImage: `url(${storyboardSheetUrl(storyboardUrl, cue.url)})`,
        backgroundPosition: `-${cue.x * scale}px -${cue.y * scale}px`,
        backgroundSize: `${sheetWidth}px ${sheetHeight}px`,
      }}
    />
  )
}

// Cropped storyboard tile for the seek-bar hover tooltip
export function StoryboardPreview({ storyboardUrl, time }: StoryboardPreviewProps) {
  const { data: cues } = useStoryboardCues(storyboardUrl)
  const match = useMemo(() => cueForTime(cues, time), [cues, time])
  const cue = match?.cue ?? null
  const cueIndex = match?.index ?? -1

  useEffect(() => {
    if (!storyboardUrl || !cues || cueIndex < 0) return
    for (const neighbor of [cues[cueIndex - 1], cues[cueIndex + 1]]) {
      if (!neighbor || neighbor.url === cue?.url) continue
      const image = new Image()
      image.src = storyboardSheetUrl(storyboardUrl, neighbor.url)
    }
  }, [cue?.url, cueIndex, cues, storyboardUrl])

  if (!storyboardUrl || !cue) return null

  return <StoryboardTile storyboardUrl={storyboardUrl} cue={cue} testId="storyboard-preview" />
}

import { useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'

import { cueForTime, parseStoryboardVtt, storyboardSheetUrl } from './storyboardVtt'

const MAX_PREVIEW_WIDTH = 320
const MAX_PREVIEW_HEIGHT = 240
const SHEET_COLUMNS = 5
const SHEET_ROWS = 5

// Props needed to load and crop an optional storyboard tile
interface StoryboardPreviewProps {
  storyboardUrl: string | null
  time: number
}

// Fetch and parse a storyboard index, treating absence as an optional feature
async function fetchStoryboard(url: string, signal?: AbortSignal) {
  const response = await fetch(url, { signal })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`Storyboard request failed (${response.status})`)
  const cues = parseStoryboardVtt(await response.text())
  return cues.length > 0 ? cues : null
}

// Cropped storyboard tile for the seek-bar hover tooltip
export function StoryboardPreview({ storyboardUrl, time }: StoryboardPreviewProps) {
  const { data: cues } = useQuery({
    queryKey: ['storyboard-vtt', storyboardUrl],
    queryFn: ({ signal }) => fetchStoryboard(storyboardUrl!, signal),
    enabled: storyboardUrl !== null,
    retry: false,
    staleTime: Infinity,
  })
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

  const scale = Math.min(1, MAX_PREVIEW_WIDTH / cue.w, MAX_PREVIEW_HEIGHT / cue.h)
  const width = Math.round(cue.w * scale)
  const height = Math.round(cue.h * scale)
  const sheetWidth = cue.w * SHEET_COLUMNS * scale
  const sheetHeight = cue.h * SHEET_ROWS * scale

  return (
    <div
      className="mv-storyboard-preview"
      data-testid="storyboard-preview"
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

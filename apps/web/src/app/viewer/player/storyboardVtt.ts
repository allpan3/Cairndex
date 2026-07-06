// One parsed storyboard VTT cue and its tile crop coordinates
export interface StoryboardCue {
  start: number
  end: number
  url: string
  x: number
  y: number
  w: number
  h: number
}

// A cue lookup result that includes its array position
export interface StoryboardCueMatch {
  cue: StoryboardCue
  index: number
}

const TIMING = /^(\d{2}:\d{2}:\d{2}\.\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2}\.\d{3})$/
const PAYLOAD = /^(\S+\.jpg(?:\?\S*)?)#xywh=(\d+),(\d+),(\d+),(\d+)$/

// Parse a strict WebVTT timestamp into seconds
function parseTimestamp(value: string): number | null {
  const parts = value.split(':')
  if (parts.length !== 3) return null
  const hours = Number(parts[0])
  const minutes = Number(parts[1])
  const seconds = Number(parts[2])
  if (![hours, minutes, seconds].every(Number.isFinite)) return null
  return hours * 3600 + minutes * 60 + seconds
}

// Parse the constrained Cairndex storyboard VTT format
export function parseStoryboardVtt(text: string): StoryboardCue[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const cues: StoryboardCue[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const timing = TIMING.exec(lines[index]?.trim() ?? '')
    if (!timing) continue
    const startText = timing[1]
    const endText = timing[2]
    const payload = PAYLOAD.exec(lines[index + 1]?.trim() ?? '')
    if (!startText || !endText) continue
    const start = parseTimestamp(startText)
    const end = parseTimestamp(endText)
    if (start === null || end === null || end <= start || !payload) continue
    const url = payload[1]
    if (!url) continue
    const x = Number(payload[2])
    const y = Number(payload[3])
    const w = Number(payload[4])
    const h = Number(payload[5])
    if ([x, y, w, h].some((value) => !Number.isFinite(value)) || w <= 0 || h <= 0) {
      continue
    }
    cues.push({ start, end, url, x, y, w, h })
  }
  return cues.sort((a, b) => a.start - b.start)
}

// Find the cue for a time, clamping the exact duration to the final cue
export function cueForTime(
  cues: StoryboardCue[] | null | undefined,
  time: number,
): StoryboardCueMatch | null {
  if (!cues?.length || !Number.isFinite(time)) return null
  const first = cues[0]
  const last = cues[cues.length - 1]
  if (!first || !last) return null
  if (time <= first.start) return { cue: first, index: 0 }
  if (time >= last.end) return { cue: last, index: cues.length - 1 }
  const index = cues.findIndex((cue) => time >= cue.start && time < cue.end)
  if (index >= 0) return { cue: cues[index]!, index }
  return { cue: last, index: cues.length - 1 }
}

// Resolve a VTT payload URL using normal relative-URL rules
export function storyboardSheetUrl(indexUrl: string, url: string): string {
  return new URL(url, new URL(indexUrl, window.location.href)).toString()
}

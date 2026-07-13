export interface QualityOption {
  label: string
  value: number | null
}

const RESOLUTION_HEIGHTS = [2160, 1440, 1080, 720, 480] as const

/** Build resolution caps at or below the probed source height. */
export function qualityOptions(sourceHeight: number | null): QualityOption[] {
  const heights =
    sourceHeight === null || sourceHeight <= 0
      ? RESOLUTION_HEIGHTS
      : RESOLUTION_HEIGHTS.filter((height) => height <= sourceHeight)
  return [
    { label: 'Auto', value: null },
    ...heights.map((height) => ({ label: `${height}p`, value: height })),
  ]
}

// Width/height ratios of covers this device has decoded, so a Justified row can give
// a cover its own shape. Browse knows a bundle's primary file dimensions, which are
// not always its cover's: a jacket image on a widescreen video, or an image nobody
// has probed yet. Measured once and kept per device, the next layout uses the real
// shape; the current one is not reflowed under the pointer while covers arrive.
const STORAGE_KEY = 'cairndex.coverAspects'
const LIMIT = 5000

let aspects: Map<string, number> | null = null
let saveTimer: number | null = null

function load(): Map<string, number> {
  if (aspects) return aspects
  aspects = new Map()
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]') as unknown
    if (Array.isArray(saved))
      for (const entry of saved)
        if (
          Array.isArray(entry) &&
          typeof entry[0] === 'string' &&
          typeof entry[1] === 'number' &&
          Number.isFinite(entry[1])
        )
          aspects.set(entry[0], entry[1])
  } catch {
    // Unavailable storage only means shapes are measured again next session
  }
  return aspects
}

function save() {
  saveTimer = null
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...load()]))
  } catch {
    // Best effort, as above
  }
}

/** Key for one cover version: `cover_key` names the file, frame and local generation. */
export function coverAspectKey(bundle: string, coverKey: string | null | undefined) {
  return `${bundle}|${coverKey ?? ''}`
}

export function measuredCoverAspect(key: string): number | undefined {
  return load().get(key)
}

export function recordCoverAspect(key: string, width: number, height: number) {
  if (!(width > 0 && height > 0)) return
  const map = load()
  const ratio = Math.round((width / height) * 1000) / 1000
  if (map.get(key) === ratio) return
  map.delete(key)
  map.set(key, ratio)
  while (map.size > LIMIT) map.delete(map.keys().next().value!)
  if (saveTimer === null) saveTimer = window.setTimeout(save, 1000)
}

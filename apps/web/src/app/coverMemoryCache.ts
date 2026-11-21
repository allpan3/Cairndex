import { hostFetch } from '../platform'

const MAX_CACHED_COVERS = 1500
const blobUrls = new Map<string, string>()
const inFlight = new Map<string, Promise<string | null>>()

/**
 * True in real browser / desktop webview runtimes where `URL.createObjectURL`
 * holds an in-memory image blob across virtualized list unmounts, even when the
 * HTTP endpoint sets `Cache-Control: private, no-store`.
 */
export function canCacheCoverBlobs(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof URL !== 'undefined' &&
    typeof URL.createObjectURL === 'function' &&
    typeof navigator !== 'undefined' &&
    !/jsdom/i.test(navigator.userAgent)
  )
}

export function getCachedCoverBlobUrl(src: string): string | undefined {
  const existing = blobUrls.get(src)
  if (!existing) return undefined
  // Refresh LRU position
  blobUrls.delete(src)
  blobUrls.set(src, existing)
  return existing
}

export function fetchCoverBlobUrl(src: string): Promise<string | null> {
  const cached = getCachedCoverBlobUrl(src)
  if (cached) return Promise.resolve(cached)
  const pending = inFlight.get(src)
  if (pending) return pending

  const request = hostFetch(src)
    .then(async (response) => {
      if (!response.ok) return null
      const blob = await response.blob()
      if (blob.size === 0) return null
      // Another caller or a scope clear may have raced while decoding bytes
      const existing = blobUrls.get(src)
      if (existing) return existing
      const objectUrl = URL.createObjectURL(blob)
      blobUrls.set(src, objectUrl)
      while (blobUrls.size > MAX_CACHED_COVERS) {
        const oldestKey = blobUrls.keys().next().value
        if (oldestKey === undefined) break
        const oldestUrl = blobUrls.get(oldestKey)
        blobUrls.delete(oldestKey)
        if (oldestUrl) URL.revokeObjectURL(oldestUrl)
      }
      return objectUrl
    })
    .catch(() => null)
    .finally(() => {
      inFlight.delete(src)
    })

  inFlight.set(src, request)
  return request
}

export function evictCoverBlobPrefix(prefix: string): void {
  for (const [key, objectUrl] of [...blobUrls.entries()]) {
    if (key === prefix || key.startsWith(`${prefix}?`)) {
      blobUrls.delete(key)
      URL.revokeObjectURL(objectUrl)
    }
  }
}

export function clearCoverBlobCache(): void {
  for (const objectUrl of blobUrls.values()) {
    URL.revokeObjectURL(objectUrl)
  }
  blobUrls.clear()
  inFlight.clear()
}

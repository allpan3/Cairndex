import { hostFetch } from '../platform'

const MAX_CACHED_COVERS = 1500
// Cap concurrent cover fetches below the browser's 6-connection-per-origin pool so
// interactive JSON API requests (inspector details, browse, status, saves) never wait
// behind slow or uncached SMB thumbnail generation.
const MAX_CONCURRENT_COVER_FETCHES = 4
const COVER_FETCH_TIMEOUT_MS = 20_000

interface CoverTask {
  src: string
  refs: number
  controller: AbortController | null
  promise: Promise<string | null>
  resolve: (value: string | null) => void
}

const blobUrls = new Map<string, string>()
const tasks = new Map<string, CoverTask>()
const queue: CoverTask[] = []
let activeFetches = 0

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

function storeBlob(src: string, blob: Blob): string {
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
}

function pumpQueue(): void {
  while (activeFetches < MAX_CONCURRENT_COVER_FETCHES && queue.length > 0) {
    // LIFO so newly visible cards at the current scroll position load before older scrolled-into items
    const task = queue.pop()!
    const controller = new AbortController()
    task.controller = controller
    activeFetches += 1
    const timer = window.setTimeout(() => controller.abort(), COVER_FETCH_TIMEOUT_MS)
    void hostFetch(task.src, { signal: controller.signal, priority: 'low' } as RequestInit)
      .then(async (response) => {
        if (!response.ok) return null
        const blob = await response.blob()
        if (blob.size === 0 || controller.signal.aborted) return null
        return storeBlob(task.src, blob)
      })
      .catch(() => null)
      .then((result) => {
        window.clearTimeout(timer)
        activeFetches -= 1
        // A remounted card can already own a new request for the same URL.
        if (tasks.get(task.src) === task) tasks.delete(task.src)
        task.resolve(result)
        pumpQueue()
      })
  }
}

export function acquireCoverBlobUrl(src: string): {
  promise: Promise<string | null>
  release: () => void
} {
  const cached = getCachedCoverBlobUrl(src)
  if (cached) {
    return { promise: Promise.resolve(cached), release: () => {} }
  }
  let task = tasks.get(src)
  if (!task) {
    let resolvePromise!: (value: string | null) => void
    const promise = new Promise<string | null>((resolve) => {
      resolvePromise = resolve
    })
    task = {
      src,
      refs: 0,
      controller: null,
      promise,
      resolve: resolvePromise,
    }
    tasks.set(src, task)
    queue.push(task)
  }
  task.refs += 1
  let released = false
  pumpQueue()
  return {
    promise: task.promise,
    release: () => {
      if (released) return
      released = true
      task.refs -= 1
      if (task.refs > 0 || tasks.get(src) !== task) return
      tasks.delete(src)
      if (task.controller) {
        task.controller.abort()
      } else {
        queue.splice(queue.indexOf(task), 1)
        task.resolve(null)
      }
    },
  }
}

export function evictCoverBlobPrefix(prefix: string): void {
  for (const [key, objectUrl] of [...blobUrls.entries()]) {
    if (key === prefix || key.startsWith(`${prefix}?`) || key.includes(prefix)) {
      blobUrls.delete(key)
      URL.revokeObjectURL(objectUrl)
    }
  }
}

export function clearCoverBlobCache(): void {
  for (const task of queue.splice(0)) {
    task.resolve(null)
  }
  for (const task of tasks.values()) {
    task.controller?.abort()
  }
  tasks.clear()
  for (const objectUrl of blobUrls.values()) {
    URL.revokeObjectURL(objectUrl)
  }
  blobUrls.clear()
}

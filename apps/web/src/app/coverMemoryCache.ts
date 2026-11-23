import { hostFetch } from '../platform'

const MAX_CACHED_COVERS = 1500
// Cap concurrent cover fetches below the browser's 6-connection-per-origin pool so
// interactive JSON API requests (inspector details, browse, status, saves) never wait
// behind slow or uncached SMB thumbnail generation.
const MAX_CONCURRENT_COVER_FETCHES = 4
const COVER_FETCH_TIMEOUT_MS = 20_000

export interface CoverBatchItem {
  endpoint: string
  bundle: string
}

const MAX_BATCH_SIZE = 16

interface CoverTask {
  src: string
  visibleRefs: number
  refs: number
  batch?: CoverBatchItem
  cancel: (() => void) | null
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

// All observations from one viewport callback enter the queue before choosing a batch.
let pumpScheduled = false
function schedulePump(batch?: CoverBatchItem): void {
  if (!batch) return pumpQueue()
  if (pumpScheduled) return
  pumpScheduled = true
  queueMicrotask(() => {
    pumpScheduled = false
    pumpQueue()
  })
}

async function fetchCovers(group: CoverTask[], signal: AbortSignal): Promise<(Blob | null)[]> {
  const first = group[0]!
  if (group.length === 1) {
    const response = await hostFetch(first.src, { signal, priority: 'low' } as RequestInit)
    return [response.ok ? await response.blob() : null]
  }
  const response = await hostFetch(first.batch!.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bundles: group.map((task) => task.batch!.bundle) }),
    signal,
  })
  if (!response.ok) return []
  const parts = await response.formData()
  return group.map((_, index) => {
    const part = parts.get(String(index))
    return part && typeof part !== 'string' ? part : null
  })
}

async function runGroup(group: CoverTask[]): Promise<void> {
  activeFetches++
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), COVER_FETCH_TIMEOUT_MS)
  for (const task of group) {
    task.cancel = () => {
      if (group.every((member) => tasks.get(member.src) !== member)) controller.abort()
    }
  }
  try {
    const blobs = await fetchCovers(group, controller.signal).catch(() => [])
    for (const [index, task] of group.entries()) {
      // A released card or earlier library cannot publish a late response.
      if (tasks.get(task.src) !== task) continue
      task.cancel = null
      const blob = blobs[index]
      if (blob?.size && !controller.signal.aborted) {
        tasks.delete(task.src)
        task.resolve(storeBlob(task.src, blob))
      } else if (group.length > 1) {
        // A cold cover or failed batch takes the normal bounded generation path once.
        task.batch = undefined
        queue.push(task)
      } else {
        tasks.delete(task.src)
        task.resolve(null)
      }
    }
  } finally {
    window.clearTimeout(timer)
    activeFetches--
    pumpQueue()
  }
}

function pumpQueue(): void {
  while (activeFetches < MAX_CONCURRENT_COVER_FETCHES && queue.length > 0) {
    let index = queue.length - 1
    while (index >= 0 && !queue[index]!.visibleRefs) index--
    if (index < 0 && activeFetches > 0) return
    const first = queue.splice(index < 0 ? 0 : index, 1)[0]!
    const group = [first]
    if (first.batch) {
      for (let i = queue.length - 1; i >= 0 && group.length < MAX_BATCH_SIZE; i--) {
        const next = queue[i]!
        if (
          next.batch?.endpoint === first.batch.endpoint &&
          !!next.visibleRefs === !!first.visibleRefs
        )
          group.push(queue.splice(i, 1)[0]!)
      }
    }
    void runGroup(group)
  }
}

export function acquireCoverBlobUrl(
  src: string,
  visible = true,
  batch?: CoverBatchItem,
): {
  setVisible: (value: boolean) => void
  promise: Promise<string | null>
  release: () => void
} {
  const cached = getCachedCoverBlobUrl(src)
  if (cached) {
    return { promise: Promise.resolve(cached), setVisible: () => {}, release: () => {} }
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
      visibleRefs: 0,
      batch,
      cancel: null,
      promise,
      resolve: resolvePromise,
    }
    tasks.set(src, task)
    queue.push(task)
  }
  task.refs += 1
  if (visible) task.visibleRefs++
  let released = false
  schedulePump(task.batch)
  return {
    promise: task.promise,
    setVisible: (value) => {
      if (released || value === visible) return
      task.visibleRefs += value ? 1 : -1
      visible = value
      schedulePump(task.batch)
    },
    release: () => {
      if (released) return
      released = true
      task.refs -= 1
      if (visible) task.visibleRefs--
      if (task.refs > 0 || tasks.get(src) !== task) return
      tasks.delete(src)
      if (task.cancel) task.cancel()
      else queue.splice(queue.indexOf(task), 1)
      task.resolve(null)
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
  queue.length = 0
  const retired = [...tasks.values()]
  tasks.clear()
  for (const task of retired) {
    task.cancel?.()
    task.resolve(null)
  }
  for (const objectUrl of blobUrls.values()) {
    URL.revokeObjectURL(objectUrl)
  }
  blobUrls.clear()
}

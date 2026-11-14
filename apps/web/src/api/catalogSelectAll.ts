// Select All takes every item the current query matches, loaded or not
// (`selection_version: 6`). The server returns the query's keys in the listing's
// order, up to 1,000 per page, without card facts or local file checks.
import { catalog } from './catalog'
import { captureRequestScope } from './requestScope'
import type { components } from './schema'

type BundleIds = components['schemas']['CatalogIdPage']
type UnbundledKeys = components['schemas']['CatalogUnbundledKeyPage']
export type UnbundledKey = components['schemas']['CatalogUnbundledKey']

const PAGE = 1000
// Page reads in flight at once, so a large view does not flood the server
const PARALLEL = 4
/** The most items Select All takes; holding more IDs in the browser is not useful. */
export const SELECT_ALL_LIMIT = 100_000

export interface SelectAllProgress {
  done: number
  total: number
}

export class SelectAllAborted extends Error {}

/**
 * Every key of one query, page by page. The total each page reports must stay
 * the same: if the view changes while it is read, the read starts again once and
 * then gives up, so a selection never silently misses or repeats items.
 */
export async function readEveryKey<T>(
  read: (offset: number, limit: number) => Promise<{ items: T[]; total: number }>,
  key: (item: T) => string,
  onProgress: (progress: SelectAllProgress) => void,
  signal: AbortSignal,
): Promise<T[]> {
  const scope = captureRequestScope()
  const checked = async (offset: number) => {
    const page = await read(offset, PAGE)
    scope()
    if (signal.aborted) throw new SelectAllAborted('Select All was cancelled.')
    return page
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const first = await checked(0)
    const total = first.total
    if (total > SELECT_ALL_LIMIT)
      throw new Error(
        `Select All takes up to ${SELECT_ALL_LIMIT.toLocaleString()} items; this view has ` +
          `${total.toLocaleString()}. Narrow it with search or filters first.`,
      )
    const pages: T[][] = [first.items]
    let changed = false
    let next = PAGE
    let done = first.items.length
    onProgress({ done, total })
    const worker = async () => {
      while (next < total && !changed) {
        const offset = next
        next += PAGE
        const page = await checked(offset)
        if (page.total !== total) changed = true
        pages[offset / PAGE] = page.items
        done += page.items.length
        onProgress({ done: Math.min(done, total), total })
      }
    }
    await Promise.all(Array.from({ length: PARALLEL }, worker))
    if (changed) continue
    const seen = new Set<string>()
    const items = pages.flat().filter((item) => {
      const id = key(item)
      if (seen.has(id)) return false
      seen.add(id)
      return true
    })
    // A shift between pages repeats one item and drops another
    if (items.length === total) return items
  }
  throw new Error('The list changed while it was being selected. Try Select All again.')
}

/** Every bundle a browse query matches, in its order. */
export function readBundleIds(
  library: string,
  query: Record<string, unknown>,
  onProgress: (progress: SelectAllProgress) => void,
  signal: AbortSignal,
): Promise<string[]> {
  return readEveryKey(
    (offset, limit) =>
      catalog<BundleIds>(library, '/bundles/browse/ids', 'POST', { ...query, offset, limit }).then(
        (page) => ({ items: page.ids, total: page.total }),
      ),
    (id) => id,
    onProgress,
    signal,
  )
}

/** Every file key in the Unbundled queue a search matches, in the listing's order. */
export function readUnbundledKeys(
  library: string,
  query: Record<string, unknown>,
  onProgress: (progress: SelectAllProgress) => void,
  signal: AbortSignal,
): Promise<UnbundledKey[]> {
  return readEveryKey(
    (offset, limit) =>
      catalog<UnbundledKeys>(library, '/files/unbundled/ids', 'POST', {
        ...query,
        offset,
        limit,
      }),
    (item) => item.relative_path,
    onProgress,
    signal,
  )
}

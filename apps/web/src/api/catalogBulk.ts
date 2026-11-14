// A selection larger than one request changes through a server bulk operation
// (`selection_version: 5`). The browser stages each bundle with the bases it read,
// then the server applies 100 bundles per batch, each batch its own event. Bundles
// changed since they were read are left as they were and reported, so the owner
// can select them and review again.
import { catalog, CatalogJobError, operationId, type Job } from './catalog'
import { captureRequestScope } from './requestScope'
import type { components } from './schema'

type BulkPage = components['schemas']['CatalogBulkMembershipPage']
type Snapshot = components['schemas']['CatalogSelectionRead']
type Unchanged = components['schemas']['CatalogBulkUnchanged']
type Observed = Record<string, string[]>

/** The most bundles one selection request names; larger selections read in chunks. */
export const SELECTION_REQUEST = 100
// Staged bundles per request, the server's page bound
const STAGE_PAGE = 500
// Chunk reads in flight at once, so a large selection does not flood the server
const PARALLEL = 4

export interface BulkItem {
  id: string
  observed: Observed
}

export type BulkChange =
  | { action: 'bulk'; field: 'title' | 'rating'; value: string | number | null }
  | {
      action: 'bulk'
      field: 'tags' | 'collections'
      target: string
      assigned: boolean
      observed: Observed
    }
  | { action: 'dissolve' }

export interface BulkProgress {
  total: number
  applied: number
  skipped: number
}

/** A bulk change that left some bundles as they were; `unchanged` lists them. */
export class CatalogBulkIncomplete extends Error {
  readonly unchanged: string[]
  constructor(message: string, unchanged: string[]) {
    super(message)
    this.unchanged = unchanged
  }
}

/** A selection this server can change together, in one request or as a bulk operation. */
export function changeableTogether(count: number, selectionVersion: number): boolean {
  return count <= SELECTION_REQUEST || selectionVersion >= 5
}

/**
 * A query-key part for a selection. A large one is named by its size and a 64-bit
 * digest, so a key does not hash 100,000 identities on every render.
 */
export function selectionKey(ids: string[]): string | string[] {
  if (ids.length <= SELECTION_REQUEST) return ids
  let a = 0x811c9dc5
  let b = 0x9e3779b9
  for (const id of ids) {
    for (let index = 0; index < id.length; index++) {
      const code = id.charCodeAt(index)
      a = Math.imul(a ^ code, 0x01000193)
      b = Math.imul(b ^ code, 0x5bd1e995)
    }
    a = Math.imul(a ^ 0x2c, 0x01000193)
    b = Math.imul(b ^ 0x2c, 0x5bd1e995)
  }
  return `${ids.length}:${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}`
}

export function chunks<T>(items: T[], size = SELECTION_REQUEST): T[][] {
  const result: T[][] = []
  for (let start = 0; start < items.length; start += size)
    result.push(items.slice(start, start + size))
  return result
}

// Map chunks in order with a few requests in flight
async function mapChunks<T, R>(items: T[][], read: (chunk: T[]) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await read(items[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, worker))
  return results
}

/** The selection read for any number of bundles, chunk by chunk. */
export async function readSelection(library: string, ids: string[]): Promise<Snapshot> {
  const pages = await mapChunks(chunks(ids), (chunk) =>
    catalog<Snapshot>(library, '/bundles/selection', 'POST', { ids: chunk }),
  )
  return { items: pages.flatMap((page) => page.items) }
}

/** One tag or collection read for every selected bundle, with each bundle's own bases. */
export interface TargetChoice {
  id: string
  name: string
  assigned_count: number
  held: boolean
  /** The shared target's lifetime basis. */
  observed: Observed
  items: BulkItem[]
}

export async function readTargetChoice(
  library: string,
  ids: string[],
  family: 'tags' | 'collections',
  target: string,
): Promise<TargetChoice | null> {
  const pages = await mapChunks(chunks(ids), (chunk) =>
    catalog<BulkPage>(library, '/bundles/selection/memberships', 'POST', {
      ids: chunk,
      family,
      target,
      limit: 1,
    }).then((page) => ({ chunk, choice: page.items[0] })),
  )
  const unit = `${family}/${target}/$alive`
  const items: BulkItem[] = []
  let shared: string[] | null = null
  let assigned = 0
  let held = false
  let name = ''
  for (const { chunk, choice } of pages) {
    if (!choice) return null
    const basis = choice.observed[unit] ?? []
    if (shared && JSON.stringify([...shared].sort()) !== JSON.stringify([...basis].sort()))
      throw new Error(`This ${family === 'tags' ? 'tag' : 'collection'} changed; try again.`)
    shared = basis
    assigned += choice.assigned_count
    held ||= choice.held
    name = choice.name
    for (const id of chunk)
      items.push({
        id,
        observed: Object.fromEntries(
          Object.entries(choice.observed).filter(
            ([key]) => key.startsWith(`asset_bundles/${id}/`) || key.includes(`/${id}~`),
          ),
        ),
      })
  }
  return {
    id: target,
    name,
    assigned_count: assigned,
    held,
    observed: { [unit]: shared ?? [] },
    items,
  }
}

/**
 * The destinations every selected bundle has, and those only some have, read chunk by
 * chunk. A destination is shared when every chunk lists it as shared.
 */
export async function readSelectionMemberships(
  library: string,
  ids: string[],
  family: 'tags' | 'collections',
): Promise<{ common: { id: string; name: string; held: boolean }[]; some: Set<string> }> {
  const all = async (chunk: string[], filter: object) => {
    const found: BulkPage['items'] = []
    let after = ''
    do {
      const page = await catalog<BulkPage>(library, '/bundles/selection/memberships', 'POST', {
        ids: chunk,
        family,
        after,
        limit: 50,
        ...filter,
      })
      found.push(...page.items)
      after = page.next_cursor ?? ''
    } while (after)
    return found
  }
  const read = await mapChunks(chunks(ids), async (chunk) => ({
    common: await all(chunk, { common: true }),
    assigned: await all(chunk, { assigned: true }),
  }))
  const shared = new Map<string, { id: string; name: string; held: boolean; chunks: number }>()
  const any = new Set<string>()
  for (const chunk of read) {
    for (const item of chunk.assigned) any.add(item.id)
    for (const item of chunk.common) {
      const entry = shared.get(item.id) ?? { id: item.id, name: item.name, held: false, chunks: 0 }
      entry.chunks += 1
      entry.held ||= item.held
      shared.set(item.id, entry)
    }
  }
  const common = [...shared.values()]
    .filter((entry) => entry.chunks === read.length)
    .map(({ id, name, held }) => ({ id, name, held }))
  return {
    common,
    some: new Set([...any].filter((id) => !common.some((item) => item.id === id))),
  }
}

type Listener = () => void
export interface BulkActivity extends BulkProgress {
  library: string
  operation: string
}
let activity: BulkActivity | null = null
const listeners = new Set<Listener>()
const publish = (next: BulkActivity | null) => {
  activity = next
  for (const listener of listeners) listener()
}

/** The bulk operation this window is following, for a progress line with Cancel. */
export function bulkActivity(): BulkActivity | null {
  return activity
}

export function subscribeBulkActivity(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Cancel stops after the batch the server is applying; finished batches stay saved. */
export async function cancelBulk(library: string, operation: string): Promise<void> {
  await catalog(library, `/jobs/${operation}`, 'DELETE')
}

/**
 * Stage the selection and run the change; resolves when every bundle changed. A
 * bundle changed elsewhere, a cancel or a stop rejects with CatalogBulkIncomplete.
 */
export async function runBulk(
  library: string,
  items: BulkItem[],
  change: BulkChange,
  operation = operationId(),
): Promise<void> {
  const scope = captureRequestScope()
  for (let start = 0; start < items.length; start += STAGE_PAGE) {
    await catalog(library, `/bundles/selection/bulk/${operation}`, 'POST', {
      start,
      items: items.slice(start, start + STAGE_PAGE),
    })
    scope()
  }
  const job = await catalog<Job>(library, '/jobs', 'POST', {
    action: 'bulk_selection',
    body: { change, total: items.length },
    operation,
  })
  scope()
  await followBulk(library, job, items.length)
}

/** Follow a queued bulk operation, here or after a reload, until it stops. */
export async function followBulk(library: string, queued: Job, staged = 0): Promise<void> {
  const scope = captureRequestScope()
  const operation = queued.id
  let job = queued
  let wait = 50
  const progress = () =>
    (job.result as unknown as BulkProgress | null) ?? { total: staged, applied: 0, skipped: 0 }
  try {
    while (job.state === 'queued' || job.state === 'running') {
      publish({ library, operation, ...progress() })
      await new Promise((resolve) => setTimeout(resolve, wait))
      wait = Math.min(wait * 2, 500)
      scope()
      job = await catalog<Job>(library, `/jobs/${operation}`)
    }
  } finally {
    if (activity?.operation === operation) publish(null)
  }
  scope()
  const { total, applied, skipped } = progress()
  const n = (value: number) => value.toLocaleString()
  if (job.state === 'succeeded' && !skipped) return
  const unchanged: string[] = []
  let start: number | null = 0
  while (start !== null) {
    const page: Unchanged = await catalog<Unchanged>(
      library,
      `/bundles/selection/bulk/${operation}/unchanged?start=${start}`,
    )
    scope()
    unchanged.push(...page.items)
    start = page.next_start ?? null
  }
  const left =
    job.state === 'succeeded'
      ? `Changed ${n(applied)} of ${n(total)} bundles. ${n(skipped)} changed elsewhere or need ` +
        'conflict review, so they were left as they were.'
      : job.state === 'cancelled'
        ? `Cancelled after ${n(applied)} of ${n(total)} bundles; the rest were left as they were.`
        : (job.error ?? 'The bulk change stopped.')
  if (job.state === 'failed' && !unchanged.length) throw new CatalogJobError(left)
  throw new CatalogBulkIncomplete(left, unchanged)
}

/** A bulk operation still running on the server, such as one started before a reload. */
export async function runningBulk(library: string): Promise<Job | null> {
  const page = await catalog<{ items: Job[] }>(library, '/jobs?limit=30')
  const found = page.items.find(
    (item) => item.action === 'bulk_selection' && item.state === 'queued',
  )
  return found ? catalog<Job>(library, `/jobs/${found.id}`) : null
}

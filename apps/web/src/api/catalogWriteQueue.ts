import { requestScopeVersion } from './requestScope'

const queues = new Map<string, Promise<void>>()

export interface CatalogWriteLockContext {
  /** True when another active local write shared at least one lock key. */
  waited: boolean
}

export const bundleLockKey = (library: string, id: string) => `${library}:asset_bundles/${id}`

export const fileLockKey = (library: string, id: string) => `${library}:asset_files/${id}`

/** Clear in-memory queue entries between isolated unit tests. */
export function resetCatalogWriteLocks(): void {
  queues.clear()
}

/**
 * Serialize same-client causal catalog writes that touch the same entity
 * lifetime (`$alive`) units, such as note/title/rating saves running alongside
 * tag, collection, member, or star edits.
 *
 * Keys are fenced by the active connection/library scope so an abandoned
 * request after switching libraries or reconnecting cannot block the new
 * scope. All keys are acquired simultaneously to prevent deadlocks, and
 * uncontended calls invoke `work` synchronously before returning so single-tick
 * UI event handlers preserve exact timing.
 */
export function withCatalogWriteLock<T>(
  keys: Iterable<string>,
  work: (context: CatalogWriteLockContext) => Promise<T>,
): Promise<T> {
  const scope = requestScopeVersion(true)
  const uniqueKeys = [...new Set(keys)]
    .filter(Boolean)
    .sort()
    .map((key) => `${scope}:${key}`)
  if (uniqueKeys.length === 0) return work({ waited: false })

  const predecessors: Promise<void>[] = []
  for (const key of uniqueKeys) {
    const active = queues.get(key)
    if (active) predecessors.push(active)
  }

  const waited = predecessors.length > 0
  let run: Promise<T>
  if (waited) {
    run = Promise.all(predecessors).then(() => work({ waited: true }))
  } else {
    try {
      run = work({ waited: false })
    } catch (error) {
      return Promise.reject(error)
    }
  }

  const release = () => {
    for (const key of uniqueKeys) {
      if (queues.get(key) === gate) queues.delete(key)
    }
  }
  const gate: Promise<void> = run.then(release, release)
  for (const key of uniqueKeys) queues.set(key, gate)

  return run
}

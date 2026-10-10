import type { QueryClient } from '@tanstack/react-query'

const bases = new WeakMap<object, string>()
const versions = new Map<string, string>()
let activeBasis: string | undefined
let displayedClient: QueryClient | undefined
const surfaces = new Map<symbol, string>()

export type EditVersion = number | string

// Read objects retain their immutable response basis, independently of later cache refreshes
export function rememberBasis<T>(value: T, basis: string | null | undefined): T {
  if (!basis) return value
  const seen = new WeakSet<object>()
  const pending: unknown[] = [value]
  while (pending.length) {
    const item = pending.pop()
    if (!item || typeof item !== 'object' || seen.has(item)) continue
    seen.add(item)
    bases.set(item, basis)
    pending.push(...Object.values(item))
  }
  return value
}

// Transformed query results inherit the oldest represented snapshot, never the newest poll
export function basisOf(value: unknown): string | undefined {
  const seen = new WeakSet<object>()
  const pending = [value]
  const found: string[] = []
  while (pending.length) {
    const item = pending.pop()
    if (!item || typeof item !== 'object' || seen.has(item)) continue
    seen.add(item)
    const direct = bases.get(item)
    if (direct) found.push(direct)
    else pending.push(...Object.values(item))
  }
  return minimumBasis(found)
}

// A selection can contain several pages; every displayed page must be covered by its basis
export function minimumBasis(values: (string | undefined)[]): string | undefined {
  const valid = values.filter((value): value is string => value !== undefined)
  if (!valid.length) return undefined
  const first = valid[0]!.split(':')
  let main = Number(first[1])
  let plans = Number(first[3])
  for (const value of valid) {
    const parts = value.split(':')
    if (parts[0] !== first[0] || parts[2] !== first[2]) return 'incompatible-read-bases'
    main = Math.min(main, Number(parts[1]))
    plans = Math.min(plans, Number(parts[3]))
  }
  return `${first[0]}:${main}:${first[2]}:${plans}`
}

// Instant actions use the data on screen before optimistic writes or asynchronous preparation
export function displayedBasis(client: QueryClient): string | undefined {
  return minimumBasis([
    ...surfaces.values(),
    ...client
      .getQueryCache()
      .findAll({ type: 'active' })
      .map((query) => basisOf(query.state.data)),
  ])
}

// Dialogs and menus inherit the visible basis before their first editable render
export function currentDisplayedBasis(): string | undefined {
  return activeBasis ?? (displayedClient ? displayedBasis(displayedClient) : undefined)
}

// One active legacy workspace supplies the query snapshot used by its transient surfaces
export function observeEditClient(client: QueryClient): () => void {
  displayedClient = client
  return () => {
    if (displayedClient === client) displayedClient = undefined
  }
}

// A background refetch cannot authorize an action already opened in a dialog or menu
export function holdEditBasis(basis: string | undefined): () => void {
  const key = Symbol()
  if (basis) surfaces.set(key, basis)
  return () => {
    surfaces.delete(key)
  }
}

// A short synchronous scope binds the API calls created by one mutation invocation
export function withEditBasis<T>(basis: string | undefined, call: () => T): T {
  const previous = activeBasis
  activeBasis = basis
  try {
    return call()
  } finally {
    activeBasis = previous
  }
}

// Capture before an await when a mutation needs several sequential API calls
export function bindEdit<T extends unknown[], R>(call: (...args: T) => R): (...args: T) => R {
  const basis = currentDisplayedBasis()
  return (...args) => withEditBasis(basis, () => call(...args))
}

// Existing version-bearing editors can retain their opening read while migrating to opaque bases
export function rememberVersionBases(url: string, value: unknown, basis: string | null): void {
  if (!basis || !value || typeof value !== 'object') return
  const row = value as { id?: string; version?: number; items?: unknown[] }
  if (row.id && row.version !== undefined) {
    const path = url.split('?')[0]!.replace(/\/browse$/, '')
    const root = path.endsWith(`/${row.id}`) ? path.slice(0, -row.id.length - 1) : path
    const key = `${root}/${row.id}:${row.version}`
    if (!versions.has(key)) versions.set(key, basis)
  }
  if (Array.isArray(value)) value.forEach((item) => rememberVersionBases(url, item, basis))
  if (row.items) rememberVersionBases(url, row.items, basis)
  while (versions.size > 8192) versions.delete(versions.keys().next().value!)
}

// An explicit opening basis takes precedence over the current invocation's visible snapshot
export function editBasis(url: string, version?: EditVersion): string | undefined {
  if (typeof version === 'string') return version
  if (version !== undefined) return versions.get(`${url}:${version}`)
  return currentDisplayedBasis()
}

// Connection/library transitions retire every compatibility lookup from the old scope
export function clearEditBases(): void {
  versions.clear()
  activeBasis = undefined
  surfaces.clear()
}

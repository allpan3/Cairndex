// Compatibility is runtime state for one active server/library, never a draft read basis.
import { requestScopeVersion } from './requestScope'

type MetadataCompatibility = 'unknown' | 'supported' | 'unsupported' | 'unavailable'
let scope = ''
let state: MetadataCompatibility = 'unknown'
let unsupported = false
const listeners = new Set<() => void>()

export const METADATA_UPGRADE_MESSAGE =
  'Metadata editing is unavailable on this server. Update the server to use this app for editing. You can still browse and play files. Your drafts are kept.'

export const validMetadataBasis = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{32}:\d+:[a-f0-9]{32}:\d+$/.test(value)

export function metadataCompatibility(): MetadataCompatibility {
  return scope === requestScopeVersion() ? state : 'unknown'
}

// A temporary outage cannot erase a confirmed incompatibility and permit an old saved request.
export function metadataEditingBlocked(): boolean {
  return scope === requestScopeVersion() && unsupported
}

// Call only after checking the request scope; late responses cannot affect a new connection.
export function setMetadataCompatibility(value: MetadataCompatibility): void {
  if (scope !== requestScopeVersion()) unsupported = false
  scope = requestScopeVersion()
  if (value !== 'unavailable') unsupported = value === 'unsupported'
  state = value
  listeners.forEach((listener) => listener())
}

export function subscribeMetadataCompatibility(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

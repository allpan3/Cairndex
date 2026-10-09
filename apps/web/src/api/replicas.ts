// Replica requests use explicit library scope so changing tabs cannot redirect a save
import { hostFetch } from '../platform'
import { captureRequestScope, getConnectionScopeKey } from './requestScope'
import { resolveApiUrl } from './client'
import type { components } from './schema'

export type ReplicaBundle = components['schemas']['ReplicaBundle']
export type ReplicaField = components['schemas']['ReplicaField']
export type ReplicaStatus = components['schemas']['ReplicaStatus']
export type Draft = components['schemas']['DraftItem']
export type Change = components['schemas']['Change']
export type FieldName = 'title' | 'notes' | 'rating'
export type Value = Change['value']
export type Changes = Partial<Record<FieldName, Change>>

// Structured errors keep unsaved work in the editor rather than throwing away the form
export async function replicaRequest<T>(
  libraryId: string,
  path: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const assertScope = captureRequestScope()
  const response = await hostFetch(resolveApiUrl(`/api/v1/libraries/${libraryId}/replica${path}`), {
    method,
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  assertScope()
  if (!response.ok) {
    const problem = (await response.json().catch(() => ({}))) as { message?: string }
    assertScope()
    throw new Error(
      problem.message ?? `Request failed (${response.status}); your draft is retained`,
    )
  }
  const result = response.status === 204 ? (undefined as T) : ((await response.json()) as T)
  assertScope()
  return result
}

// A browser lock separates duplicated tabs that initially inherit the same session storage
export function holdEditor(onReady: (id: string) => void): () => void {
  const key = 'cairndex.replica.editor'
  let stopped = false
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  async function acquire() {
    let id: string
    try {
      id = sessionStorage.getItem(key) ?? crypto.randomUUID().replaceAll('-', '')
    } catch {
      id = crypto.randomUUID().replaceAll('-', '')
    }
    while (!stopped) {
      if (!navigator.locks) {
        onReady(crypto.randomUUID().replaceAll('-', ''))
        return
      }
      const finished = await navigator.locks.request(
        `cairndex-editor-${id}`,
        { ifAvailable: true },
        async (lock) => {
          if (stopped) return true
          if (!lock) return false
          try {
            sessionStorage.setItem(key, id)
          } catch {
            /* Server drafts remain available */
          }
          onReady(id)
          await held
          return true
        },
      )
      if (finished) return
      id = crypto.randomUUID().replaceAll('-', '')
    }
  }
  // Defer admission until StrictMode has cancelled its disposable first effect
  queueMicrotask(() => {
    if (!stopped) void acquire()
  })
  window.addEventListener('pagehide', release)
  return () => {
    stopped = true
    release()
    window.removeEventListener('pagehide', release)
  }
}

// Include the connection and library so private drafts never bleed across scopes
export function draftKey(libraryId: string, bundleId: string, editor: string): string {
  return `cairndex.replica.draft:${getConnectionScopeKey() === 'local' ? `local/api/v1/libraries/${libraryId}` : resolveApiUrl(`/api/v1/libraries/${libraryId}`)}:${bundleId}:${editor}`
}

// Display whole ordered notes as content, never as JSON or an implementation identifier
export function displayValue(value: Value): string {
  return Array.isArray(value) ? value.join('\n\n') : value === null ? 'Unrated' : String(value)
}

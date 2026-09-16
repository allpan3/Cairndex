import { hostFetch } from '../platform'
import { getActiveLibraryId, resolveApiUrl } from './client'
import { rememberBasis, rememberVersionBases } from './editBasis'
import { captureRequestScope, getConnectionScopeKey } from './requestScope'
import { finishStoredBundleDraft } from '../state/useBundleDraft'
import { finishStoredFieldDrafts } from '../state/useMetadataDraft'

export interface EditConflict {
  unit: string
  revision: number
  current: unknown
  proposed: unknown
  reviewable: boolean
}

export interface PendingEdit {
  id: string
  url: string
  method: string
  body: string | undefined
  basis: string | undefined
  operation: string
  reviewed: Record<string, number>
  message: string
  conflict?: EditConflict
  recovery?: { basis: string; current: unknown; proposed: unknown }
}

type Choice = 'retry' | 'reviewed' | 'keep' | 'discard'
const listeners = new Set<() => void>()
const retained = new Map<string, PendingEdit[]>()
const waiting = new Map<string, (choice: Choice) => void>()
let shown: string | null = null
let serial = 0
const inFlight = new Map<string, Promise<unknown>>()
const storageFailures = new Set<string>()
export const editStorageWarning = () => storageFailures.has(storageKey())
const validBasis = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{32}:\d+:[a-f0-9]{32}:\d+$/.test(value)

// Cryptographic operation identities also work on private LAN HTTP origins
function editId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

// Draft requests remain private and are isolated by durable server/library identity
function storageKey(): string {
  return `cairndex.metadataEdits:${getConnectionScopeKey() ?? 'web'}:${getActiveLibraryId() ?? ''}`
}

// Cache a stable snapshot for useSyncExternalStore and retain in-memory drafts on storage failure
export function pendingEdits(): PendingEdit[] {
  const key = storageKey()
  if (!retained.has(key)) {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(key) ?? '[]')
      retained.set(
        key,
        Array.isArray(stored)
          ? stored.filter(validPending).map((item) => ({
              ...item,
              recovery: undefined,
              message:
                item.message || 'This save was interrupted. Its original request is retained.',
            }))
          : [],
      )
    } catch {
      retained.set(key, [])
    }
  }
  return retained.get(key)!
}

// Recovered bytes cannot turn into a request outside the active library's metadata API
function validPending(value: unknown): value is PendingEdit {
  if (!value || typeof value !== 'object') return false
  const item = value as PendingEdit
  return (
    typeof item.id === 'string' &&
    /^[a-zA-Z0-9_-]{16,100}$/.test(item.id) &&
    typeof item.url === 'string' &&
    item.url.startsWith(`/api/v1/libraries/${getActiveLibraryId()}/`) &&
    !/[?#%\\]/.test(item.url) &&
    !item.url.split('/').includes('..') &&
    isMetadataWrite(item.url, item.method) &&
    typeof item.operation === 'string' &&
    /^[a-zA-Z0-9_-]{16,100}$/.test(item.operation) &&
    (item.body === undefined || typeof item.body === 'string') &&
    (item.basis === undefined || typeof item.basis === 'string') &&
    typeof item.message === 'string' &&
    typeof item.reviewed === 'object' &&
    item.reviewed !== null &&
    !Array.isArray(item.reviewed) &&
    Object.entries(item.reviewed).every(
      ([key, revision]) => key.length <= 256 && Number.isSafeInteger(revision) && revision >= 0,
    )
  )
}

// Notify the shared review surface after a scoped durable draft transition
function publish(key: string, items: PendingEdit[]): void {
  retained.set(key, items)
  try {
    localStorage.setItem(key, JSON.stringify(items))
    storageFailures.delete(key)
  } catch {
    storageFailures.add(key)
  }
  serial += 1
  listeners.forEach((listener) => listener())
}

// The subscription carries state changes without introducing another frontend state framework
export function subscribeEdits(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const editSnapshot = () => serial
// Clearing an accepted or discarded request also acknowledges any matching field draft
function finishDraft(edit: PendingEdit): void {
  finishStoredBundleDraft(edit.url, edit.body)
  finishStoredFieldDrafts(edit.url, edit.body)
  window.dispatchEvent(
    new CustomEvent('cairndex:metadata-finished', { detail: { url: edit.url, body: edit.body } }),
  )
}

export const shownEdit = () => pendingEdits().find((edit) => edit.id === shown) ?? null

// Switching away stops old continuations while retaining their scoped request drafts
export function retireMetadataRequests(): void {
  for (const resume of waiting.values()) resume('keep')
  shown = null
  serial += 1
  queueMicrotask(() => listeners.forEach((listener) => listener()))
}

// A dismissed conflict can be reopened with exactly its retained request and basis
export function openEdit(id: string): void {
  shown = id
  serial += 1
  listeners.forEach((listener) => listener())
}

// Only explicit owner choices resume an overwrite; closing retains the original request
export async function chooseEdit(edit: PendingEdit, choice: Choice): Promise<void> {
  const resume = waiting.get(edit.id)
  if (resume) {
    resume(choice)
    return
  }
  if (choice === 'keep' || choice === 'discard') {
    if (choice === 'discard') finishDraft(edit)
    shown = null
    publish(
      storageKey(),
      choice === 'discard'
        ? pendingEdits().filter((item) => item.id !== edit.id)
        : [...pendingEdits()],
    )
    return
  }
  if (choice === 'reviewed' && edit.recovery)
    edit = {
      ...edit,
      basis: edit.recovery.basis,
      recovery: undefined,
      operation: editId(),
    }
  if (choice === 'reviewed' && edit.conflict?.reviewable) {
    edit = {
      ...edit,
      reviewed: { ...edit.reviewed, [edit.conflict.unit]: edit.conflict.revision },
      operation: editId(),
    }
  }
  try {
    await executeEdit(edit)
  } catch {
    /* The review surface retains the failure */
  }
}

// A failed mutation can be distinguished from a successful receipt without losing its draft
export class MetadataEditError extends Error {
  readonly discarded: boolean
  constructor(message: string, discarded = false) {
    super(message)
    this.discarded = discarded
    this.name = 'MetadataEditError'
  }
}

// Execute one immutable attempt, preserving its identity after an uncertain network result
function executeEdit<T>(initial: PendingEdit): Promise<T> {
  const existing = inFlight.get(initial.id)
  if (existing) return existing as Promise<T>
  const result = runEdit<T>(initial).finally(() => inFlight.delete(initial.id))
  inFlight.set(initial.id, result)
  return result
}

// Only historical scalar drafts can acquire a basis after every proposed field is shown for review
async function recoverEdit(edit: PendingEdit): Promise<PendingEdit['recovery']> {
  if (
    edit.method !== 'PATCH' ||
    !edit.body ||
    !/\/(bundles|collections|tags|smart-collections)\/[^/]+$/.test(edit.url)
  )
    return undefined
  const proposed = JSON.parse(edit.body) as Record<string, unknown>
  if (
    !proposed ||
    Array.isArray(proposed) ||
    !Object.keys(proposed).length ||
    Object.keys(proposed).some(
      (key) =>
        ![
          'title',
          'notes',
          'rating',
          'name',
          'note',
          'color',
          'filter',
          'default_sort',
          'default_layout',
        ].includes(key),
    )
  )
    return undefined
  const response = await hostFetch(resolveApiUrl(edit.url))
  const basis = response.headers?.get('X-Cairndex-Basis')
  if (!response.ok || !validBasis(basis)) return undefined
  const row = (await response.json()) as Record<string, unknown>
  return {
    basis,
    proposed,
    current: Object.fromEntries(Object.keys(proposed).map((key) => [key, row[key]])),
  }
}

// Execute one attempt; no request is sent without a usable opening basis
async function runEdit<T>(initial: PendingEdit): Promise<T> {
  const assertScope = captureRequestScope()
  const key = storageKey()
  let edit = initial
  for (;;) {
    assertScope()
    publish(key, [...(retained.get(key) ?? []).filter((item) => item.id !== edit.id), edit])
    const headers: Record<string, string> = { 'X-Cairndex-Operation': edit.operation }
    if (edit.basis) headers['X-Cairndex-Basis'] = edit.basis
    if (edit.body !== undefined) headers['Content-Type'] = 'application/json'
    if (Object.keys(edit.reviewed).length)
      headers['X-Cairndex-Review'] = JSON.stringify(edit.reviewed)
    let message = 'The save could not be confirmed. Retry sends the same request safely.'
    let conflict: EditConflict | undefined
    let recovery: PendingEdit['recovery']
    try {
      if (!validBasis(edit.basis)) {
        recovery = await recoverEdit(edit)
        assertScope()
        throw new MetadataEditError(
          recovery
            ? 'This retained draft has no safe opening version. Review every proposed field before saving.'
            : 'This client needs a metadata read basis. Reload or upgrade the app and server; your draft is retained.',
        )
      }
      const response = await hostFetch(resolveApiUrl(edit.url), {
        method: edit.method,
        headers,
        body: edit.body,
      })
      assertScope()
      if (response.ok) {
        const result = (response.status === 204 ? undefined : await response.json()) as T
        assertScope()
        const basis = response.headers.get('X-Cairndex-Basis')
        rememberBasis(result, basis)
        rememberVersionBases(edit.url, result, basis)
        if (shown === edit.id) shown = null
        publish(
          key,
          (retained.get(key) ?? []).filter((item) => item.id !== edit.id),
        )
        finishDraft(edit)
        window.dispatchEvent(
          new CustomEvent('cairndex:metadata-saved', {
            detail: { url: edit.url, body: edit.body, basis },
          }),
        )
        return result
      }
      const error = (await response.json().catch(() => null)) as {
        code?: string
        message?: string
        details?: EditConflict
      } | null
      assertScope()
      message =
        error?.message ?? `The save failed (HTTP ${response.status}). Your draft is retained.`
      if (error?.code === 'version_conflict' && error.details?.unit) conflict = error.details
    } catch (error) {
      assertScope()
      if (error instanceof MetadataEditError) message = error.message
    }
    edit = { ...edit, message, conflict, recovery }
    shown = edit.id
    publish(key, [...(retained.get(key) ?? []).filter((item) => item.id !== edit.id), edit])
    window.dispatchEvent(new Event('cairndex:metadata-refresh'))
    if (listeners.size === 0) throw new MetadataEditError(message)
    const choice = await new Promise<Choice>((resolve) => waiting.set(edit.id, resolve))
    waiting.delete(edit.id)
    assertScope()
    if (choice === 'keep' || choice === 'discard') {
      if (choice === 'discard') finishDraft(edit)
      shown = null
      if (choice === 'discard')
        publish(
          key,
          (retained.get(key) ?? []).filter((item) => item.id !== edit.id),
        )
      else publish(key, [...(retained.get(key) ?? [])])
      throw new MetadataEditError(message, choice === 'discard')
    }
    if (choice === 'reviewed' && recovery)
      edit = { ...edit, basis: recovery.basis, recovery: undefined, operation: editId() }
    if (choice === 'reviewed' && conflict?.reviewable) {
      edit = {
        ...edit,
        reviewed: { ...edit.reviewed, [conflict.unit]: conflict.revision },
        operation: editId(),
      }
    }
  }
}

// Opening context is supplied by the editor or its mutation invocation, never fetched during save
export function sendMetadata<T>(
  url: string,
  method: string,
  body: unknown,
  basis: string | undefined,
): Promise<T> {
  const encoded = body === undefined ? undefined : JSON.stringify(body)
  const pending = pendingEdits().find(
    (item) =>
      item.url === url && item.method === method && item.body === encoded && item.basis === basis,
  )
  if (pending) return executeEdit<T>(pending)
  return executeEdit<T>({
    id: editId(),
    url,
    method,
    body: encoded,
    basis,
    operation: editId(),
    reviewed: {},
    message: '',
  })
}

// All mutation families routed through MetadataRoute share one contract; source/runtime APIs do not
export function isMetadataWrite(url: string, method: string): boolean {
  if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) return false
  const path = url.split('?')[0]!.replace(/^\/api\/v1\/libraries\/[^/]+\//, '')
  if (
    path === url ||
    /\/(browse|opened|cursor|progress|progress-beacon|delete-with-files)$/.test(path)
  )
    return false
  return (
    /^(bundles|collections|tags|tag-groups|smart-collections|grouping)(\/|$)/.test(path) ||
    /^files\/[^/]+\/cover-frame$/.test(path) ||
    /^manual-bundling\/(add-files|create-bundle|empty-bundle)$/.test(path) ||
    path === 'fast-add'
  )
}

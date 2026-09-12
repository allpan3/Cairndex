import { basisOf, rememberBasis } from '../api/editBasis'
import { useEffect, useState } from 'react'
import { getActiveLibraryId, type BundlePatch, type BundleRead } from '../api/client'
import { getConnectionScopeKey } from '../api/requestScope'

type Draft = {
  version: number
  patch: Pick<BundlePatch, 'title' | 'notes'>
  bases?: Partial<Record<'title' | 'notes', string>>
}
const retained = new Map<string, Draft>()
const memoryOnly = new Set<string>()

// Content preferences and drafts belong to the server and library, never just a portable UUID
export function libraryStateKey(name: string): string {
  return `${name}:${getConnectionScopeKey() ?? 'web'}:${getActiveLibraryId() ?? ''}`
}

// A recovered request can finish after its original inspector has unmounted
export function finishStoredBundleDraft(url: string, body: string | undefined): void {
  const identity = url.match(/\/bundles\/([^/]+)$/)?.[1]
  if (!identity || !body) return
  const key = libraryStateKey(`cairndex.bundleDraft:${identity}`)
  try {
    const patch = JSON.parse(body) as Draft['patch']
    const current =
      retained.get(key) ?? (JSON.parse(localStorage.getItem(key) ?? 'null') as Draft | null)
    if (!current?.patch) return
    const remaining = { ...current.patch }
    for (const field of ['title', 'notes'] as const) {
      const value = field === 'notes' ? current.patch.notes : current.patch.title || null
      if (field in patch && JSON.stringify(value) === JSON.stringify(patch[field]))
        delete remaining[field]
    }
    const next = Object.keys(remaining).length ? { ...current, patch: remaining } : null
    if (next) retained.set(key, next)
    else retained.delete(key)
    memoryOnly.add(key)
    if (next) localStorage.setItem(key, JSON.stringify(next))
    else localStorage.removeItem(key)
    memoryOnly.delete(key)
  } catch {
    // Keep unreadable bytes and session drafts available for the inspector's storage warning
  }
}

// Keeps unsaved legacy title and notes with their original optimistic-concurrency version
export function useBundleDraft(bundle: BundleRead) {
  const key = libraryStateKey(`cairndex.bundleDraft:${bundle.id}`)
  const [initial] = useState(() => {
    try {
      const raw = localStorage.getItem(key)
      const draft = memoryOnly.has(key)
        ? (retained.get(key) ?? null)
        : raw
          ? (JSON.parse(raw) as Draft)
          : null
      if (
        draft &&
        (!Number.isInteger(draft.version) ||
          !draft.patch ||
          (draft.patch.title !== undefined &&
            draft.patch.title !== null &&
            typeof draft.patch.title !== 'string') ||
          (draft.patch.notes !== undefined &&
            (!Array.isArray(draft.patch.notes) ||
              draft.patch.notes.some((note) => typeof note !== 'string'))))
      )
        throw new Error('Invalid draft')
      if (draft) retained.set(key, draft)
      else retained.delete(key)
      return { draft, error: '' }
    } catch {
      return {
        draft: retained.get(key) ?? null,
        error: 'The saved draft could not be read. Its stored bytes are retained.',
      }
    }
  })
  const [draft, setDraft] = useState<Draft | null>(initial.draft)
  const [error, setError] = useState(initial.error)

  // Store immediately so clicking a destination in the same event cannot lose the last keystroke
  function store(next: Draft | null) {
    if (next) retained.set(key, next)
    else retained.delete(key)
    setDraft(next)
    try {
      if (next) {
        if (initial.error && !localStorage.getItem(`${key}.unreadable`))
          localStorage.setItem(`${key}.unreadable`, localStorage.getItem(key) ?? '')
        localStorage.setItem(key, JSON.stringify(next))
      } else localStorage.removeItem(key)
      memoryOnly.delete(key)
      setError('')
    } catch {
      memoryOnly.add(key)
      setError('Draft kept for this session. Browser storage is unavailable; save before quitting.')
    }
  }

  // A successful receipt clears only fields still equal to the submitted generation
  function saved(patch: Draft['patch'], version: number) {
    void version // Entity counters remain compatible with existing draft callers
    const current = retained.get(key)
    if (!current) return
    const remaining = { ...current.patch }
    for (const field of ['title', 'notes'] as const)
      if (field in patch && JSON.stringify(remaining[field]) === JSON.stringify(patch[field]))
        delete remaining[field]
    store(Object.keys(remaining).length ? { ...current, patch: remaining } : null)
  }

  useEffect(() => {
    const finished = (event: Event) => {
      const detail = (event as CustomEvent<{ url: string; body?: string }>).detail
      if (!detail.url.endsWith(`/bundles/${bundle.id}`) || !detail.body) return
      store(retained.get(key) ?? null)
    }
    window.addEventListener('cairndex:metadata-finished', finished)
    return () => window.removeEventListener('cairndex:metadata-finished', finished)
  })

  return {
    patch: draft?.patch ?? {},
    version: draft?.version ?? bundle.version,
    recovered: initial.draft !== null && draft !== null,
    error,
    bind: (patch: BundlePatch, field: 'title' | 'notes') =>
      rememberBasis(
        patch,
        field in (retained.get(key)?.patch ?? {})
          ? (retained.get(key)?.bases?.[field] ?? 'unversioned-draft')
          : basisOf(bundle),
      ),
    update: (patch: Draft['patch']) => {
      const current = retained.get(key)
      const bases = { ...current?.bases }
      for (const field of ['title', 'notes'] as const)
        if (field in patch && !(field in (current?.patch ?? {}))) bases[field] = basisOf(bundle)
      store({
        version: current?.version ?? bundle.version,
        patch: { ...current?.patch, ...patch },
        bases,
      })
    },
    saved,
    discard: () => store(null),
  }
}

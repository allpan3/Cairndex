import { useState } from 'react'
import { getActiveLibraryId, type BundlePatch, type BundleRead } from '../api/client'
import { getConnectionScopeKey } from '../api/requestScope'

type Draft = { version: number; patch: Pick<BundlePatch, 'title' | 'notes'> }
const retained = new Map<string, Draft>()
const memoryOnly = new Set<string>()

// Content preferences and drafts belong to the server and library, never just a portable UUID
export function libraryStateKey(name: string): string {
  return `${name}:${getConnectionScopeKey() ?? 'web'}:${getActiveLibraryId() ?? ''}`
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
    const current = retained.get(key)
    if (!current) return
    const remaining = { ...current.patch }
    for (const field of ['title', 'notes'] as const)
      if (field in patch && JSON.stringify(remaining[field]) === JSON.stringify(patch[field]))
        delete remaining[field]
    store(Object.keys(remaining).length ? { version, patch: remaining } : null)
  }

  return {
    patch: draft?.patch ?? {},
    version: draft?.version ?? bundle.version,
    recovered: initial.draft !== null && draft !== null,
    error,
    update: (patch: Draft['patch']) =>
      store({
        version: draft?.version ?? bundle.version,
        patch: { ...(retained.get(key)?.patch ?? {}), ...patch },
      }),
    saved,
    discard: () => store(null),
  }
}

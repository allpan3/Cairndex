// Reusable private drafts cover creation, conflict review and prepared structural operations
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { catalog, operationId } from '../api/catalog'
import { draftKey } from '../api/replicas'

type Envelope<T> = { id: string; revision: number; body: T }

// Draft records are untrusted storage and must match the current editor's simple shape
function valid<T extends object>(value: unknown, initial: T): value is Envelope<T> {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<Envelope<T>>
  if (
    typeof item.id !== 'string' ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(item.id) ||
    !Number.isInteger(item.revision) ||
    item.revision! < 1 ||
    item.revision! > 2_000_000_000 ||
    !item.body ||
    typeof item.body !== 'object' ||
    Array.isArray(item.body)
  )
    return false
  const body = item.body as Record<string, unknown>
  return (
    Object.keys(body).length === Object.keys(initial).length &&
    Object.entries(initial).every(([key, sample]) => {
      const field = body[key]
      return typeof sample === 'object'
        ? field !== null &&
            typeof field === 'object' &&
            !Array.isArray(field) &&
            Object.values(field).every((cell) => typeof cell === 'string')
        : typeof field === typeof sample
    })
  )
}

// Separate owners and monotonic receipts keep delayed writes from reviving dismissed work
export function useCatalogDraft<T extends object>(
  library: string,
  owner: string,
  editor: string,
  initial: T,
) {
  const key = draftKey(library, owner, editor)
  const [loaded] = useState(() => {
    try {
      const raw = localStorage.getItem(key)
      const parsed: unknown = raw ? JSON.parse(raw) : null
      if (parsed !== null && !valid(parsed, initial)) throw new Error('Invalid draft')
      return { envelope: parsed as Envelope<T> | null, error: '' }
    } catch {
      return {
        envelope: null,
        error: 'The browser draft could not be read. Its stored bytes are retained.',
      }
    }
  })
  const [error, setError] = useState(loaded.error)
  const [envelope, setEnvelope] = useState<Envelope<T> | null>(loaded.envelope)
  const copies = useQuery({
    queryKey: ['catalog-private-work', library, owner],
    queryFn: () =>
      catalog<{ items: Envelope<T>[] }>(library, `/drafts?owner=${encodeURIComponent(owner)}`),
    refetchInterval: 4000,
  })
  // Browser storage is written immediately; server delivery retries the same generation
  function update(body: T) {
    const next = {
      id: envelope?.id ?? operationId(),
      revision: (envelope?.revision ?? 0) + 1,
      body,
    }
    try {
      if (loaded.error && !localStorage.getItem(`${key}.unreadable`))
        localStorage.setItem(`${key}.unreadable`, localStorage.getItem(key) ?? '')
      localStorage.setItem(key, JSON.stringify(next))
    } catch {
      setError('Browser draft storage is unavailable.')
    }
    setEnvelope(next)
  }
  // Explicit dismissal acknowledges the generation before clearing the browser copy
  async function discard() {
    if (envelope)
      await catalog(library, `/drafts/${envelope.id}?revision=${envelope.revision}`, 'DELETE')
    localStorage.removeItem(key)
    setEnvelope(null)
    void copies.refetch()
  }
  useEffect(() => {
    if (!envelope) return
    // Send only the declared API fields; retry disconnected generations until unmounted
    const deliver = () =>
      void catalog(library, `/drafts/${owner}/${envelope.id}`, 'PUT', {
        revision: envelope.revision,
        body: envelope.body,
      }).catch((reason: Error) => setError(reason.message))
    deliver()
    const timer = setInterval(deliver, 4000)
    return () => clearInterval(timer)
  }, [library, owner, envelope])
  return {
    body: envelope?.body ?? initial,
    update,
    discard,
    error,
    copies:
      copies.data?.items.filter((item) => valid(item, initial) && item.id !== envelope?.id) ?? [],
  }
}

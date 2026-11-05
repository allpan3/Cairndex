import { hostFetch } from '../platform'
import { resolveApiUrl } from './client'
import { captureRequestScope } from './requestScope'
import type { components } from './schema'

export type SourceJob = components['schemas']['SourceJob']
type RequestSchema = components['schemas']['SourceRequest']
export type SourceRequest = Pick<RequestSchema, 'operation' | 'action'> &
  Partial<Omit<RequestSchema, 'operation' | 'action'>>
export type SourcePage = components['schemas']['SourcePage']
export type Version = {
  operation: string
  version: 'source' | 'destination'
  evidence: { algorithm: 'sha256' | 'tree-sha256-v1'; size: number; digest: string }
}
export type SourceReceipt = {
  operation: string
  action: string
  source: string
  destination: string
  undo_of: string | null
  versions_before: Record<string, Version | null>
  versions_after: Record<string, Version | null>
  metadata: { changes: { unit: string; value: string }[] } | null
}
export type ReceiptPage = {
  items: { id: string; state: string; error: string | null; receipt: SourceReceipt | null }[]
  next_cursor: string | null
}

// Every request keeps its original server/library scope through reply delivery.
export async function sourceRequest<T>(
  library: string,
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  const current = captureRequestScope()
  const response = await hostFetch(
    resolveApiUrl(`/api/v1/libraries/${library}/source-operations${path}`),
    {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  )
  current()
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as { message?: string }
    current()
    throw new Error(error.message ?? `Source operation failed (${response.status})`)
  }
  const result = response.status === 204 ? undefined : await response.json()
  current()
  return result as T
}

export async function uploadSource(
  library: string,
  upload: string,
  file: File,
  signal: AbortSignal,
  onProgress?: (received: number) => void,
): Promise<void> {
  const current = captureRequestScope()
  const progressUrl = resolveApiUrl(
    `/api/v1/libraries/${library}/source-operations/uploads/${upload}`,
  )
  let finished = false
  const monitor = new AbortController()
  const polling = onProgress
    ? (async () => {
        while (!finished && !signal.aborted) {
          try {
            const response = await hostFetch(progressUrl, { signal: monitor.signal })
            current()
            if (response.ok) {
              const progress = (await response.json()) as { received: number }
              current()
              if (!finished) onProgress(progress.received)
            }
          } catch {
            // Telemetry failure must not interrupt a healthy upload.
          }
          if (!finished)
            await new Promise<void>((resolve) => {
              const done = () => {
                clearTimeout(timer)
                monitor.signal.removeEventListener('abort', done)
                resolve()
              }
              const timer = setTimeout(done, 500)
              monitor.signal.addEventListener('abort', done, { once: true })
              if (monitor.signal.aborted) done()
            })
        }
      })()
    : Promise.resolve()
  try {
    const response = await hostFetch(
      resolveApiUrl(
        `/api/v1/libraries/${library}/source-operations/uploads/${upload}?size=${file.size}`,
      ),
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
        signal,
      },
    )
    current()
    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as { message?: string }
      current()
      throw new Error(error.message ?? `Copy upload failed (${response.status})`)
    }
    onProgress?.(file.size)
  } finally {
    finished = true
    monitor.abort()
    await polling
  }
}

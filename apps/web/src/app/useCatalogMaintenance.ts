import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { catalog, operationId } from '../api/catalog'
import { replicaRequest } from '../api/replicas'

type Kind = 'probe' | 'storyboards'
type Progress = { completed: number; total: number; failed: number; skipped: number }
type Maintenance = {
  kind: Kind | null
  job: {
    id: string
    state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
    result: Progress | null
    error: string | null
  } | null
}

export function useCatalogMaintenance(library: string, enabled: boolean) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const operations = useRef<Partial<Record<Kind, string>>>({})
  const startedRef = useRef<string | null>(null)
  const status = useQuery({
    queryKey: ['catalog-maintenance', library],
    enabled,
    queryFn: ({ signal }) =>
      replicaRequest<Maintenance>(library, '/media/maintenance', 'GET', undefined, signal),
    refetchInterval: 1000,
  })
  const active = ['queued', 'running'].includes(status.data?.job?.state ?? '')
  async function start(kind: Kind) {
    setBusy(true)
    setError('')
    const operation = (operations.current[kind] ??= operationId())
    try {
      const response = await replicaRequest<Maintenance>(library, '/media/maintenance', 'POST', {
        operation,
        kind,
      })
      startedRef.current = response.job?.id ?? null
      delete operations.current[kind]
      await status.refetch()
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function cancel() {
    const job = status.data?.job
    if (!job) return
    setBusy(true)
    setError('')
    try {
      await catalog(library, `/jobs/${job.id}`, 'DELETE')
      await status.refetch()
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return {
    status,
    active,
    busy,
    error,
    startedRef,
    canStart: enabled && !busy && !status.isPending && !active,
    start,
    cancel,
  }
}

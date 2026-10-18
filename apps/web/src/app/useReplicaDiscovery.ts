import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { operationId } from '../api/catalog'
import {
  discovery,
  type DiscoveryCandidate,
  type DiscoveryReview,
  type DiscoveryRun,
} from '../api/discovery'

/**
 * Update and discovery review state for one library.
 *
 * The workspace holds it, so the review keeps its place while the owner moves
 * between the bundle browser and metadata review, and a refresh cannot discard
 * the selected editor's draft.
 */
export function useReplicaDiscovery(library: string, enabled: boolean, refresh: () => void) {
  // The review is a dialog. The owner opens it, and so does an Update this
  // window started that leaves discoveries to decide (below).
  const [open, setOpen] = useState(false)
  // The run this window started, until it finishes
  const [started, setStarted] = useState<string | null>(null)
  // That run once it succeeded, until a view has reported its result
  const [finished, setFinished] = useState<DiscoveryRun | null>(null)
  const clearFinished = useCallback(() => setFinished(null), [])
  const [after, setAfter] = useState('')
  const [candidate, setCandidate] = useState<DiscoveryCandidate | null>(null)
  const [reviewId, setReviewId] = useState<string | null>(null)
  const [reviewsAfter, setReviewsAfter] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [startOperation, setStartOperation] = useState(operationId)
  const run = useQuery({
    queryKey: ['discovery-run', library],
    queryFn: ({ signal }) => discovery<DiscoveryRun>(library, '/status', 'GET', undefined, signal),
    enabled,
    refetchInterval: 1000,
  })
  const candidates = useQuery({
    queryKey: ['discovery-candidates', library, after],
    queryFn: ({ signal }) =>
      discovery<{ items: DiscoveryCandidate[]; next_cursor: string | null }>(
        library,
        `/candidates?after=${encodeURIComponent(after)}`,
        'GET',
        undefined,
        signal,
      ),
    enabled,
    refetchInterval: 1500,
  })
  // As v0.2.1's grouping review after Update: a run this window started opens
  // the review when it leaves discoveries to decide, and only then. The hook
  // does it, not a view, so it happens in either view and only once.
  const succeeded = run.data?.state === 'succeeded' && run.data.id === started ? run.data : null
  const { refetch: refetchCandidates } = candidates
  const handled = useRef<string | null>(null)
  useEffect(() => {
    if (!succeeded?.id || handled.current === succeeded.id) return
    handled.current = succeeded.id
    // The candidates are fetched again first: the list polled before the run
    // finished cannot say what it left
    void refetchCandidates().then(({ data }) => {
      setStarted(null)
      setFinished(succeeded)
      if (data?.items.length) setOpen(true)
    })
  }, [succeeded, refetchCandidates])
  const reviews = useQuery({
    queryKey: ['discovery-reviews', library, reviewsAfter],
    queryFn: ({ signal }) =>
      discovery<{ items: DiscoveryReview[]; next_cursor: string | null }>(
        library,
        `/reviews?after=${encodeURIComponent(reviewsAfter)}`,
        'GET',
        undefined,
        signal,
      ),
    enabled: enabled && open,
    refetchInterval: 2000,
  })
  const review = useQuery({
    queryKey: ['discovery-review', library, reviewId],
    queryFn: ({ signal }) =>
      discovery<DiscoveryReview>(library, `/reviews/${reviewId}`, 'GET', undefined, signal),
    enabled: enabled && open && Boolean(reviewId),
    refetchInterval: 500,
  })
  // A failed network request retains its operation ID; only a successful enqueue starts a new one
  async function start() {
    setBusy(true)
    setError('')
    try {
      await discovery(library, '/runs', 'POST', { operation: startOperation })
      setStarted(startOperation)
      setStartOperation(operationId())
      void run.refetch()
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function action(path: string, method: string, body?: unknown) {
    setBusy(true)
    setError('')
    try {
      await discovery(library, path, method, body)
      void run.refetch()
      if (reviewId) void review.refetch()
      void candidates.refetch()
      refresh()
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const running = run.data?.state === 'running'
  return {
    enabled,
    run,
    candidates,
    reviews,
    review,
    open: enabled && open,
    setOpen,
    finished,
    clearFinished,
    pending: Boolean(candidates.data?.items.length),
    after,
    setAfter,
    candidate,
    setCandidate,
    reviewId,
    setReviewId,
    reviewsAfter,
    setReviewsAfter,
    error,
    busy,
    running,
    canStart: !busy && !run.isPending && !running,
    start,
    cancel: () => void action(`/runs/${run.data!.id}`, 'DELETE'),
    action,
    refresh,
  }
}

export type ReplicaDiscoveryState = ReturnType<typeof useReplicaDiscovery>

import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { operationId } from '../../api/catalog'
import { discovery, type DiscoveryReview, type DiscoveryVerification } from '../../api/discovery'
import {
  grouping,
  type GroupingCommand,
  type GroupingIntent,
  type GroupingStatus,
  type GroupingWorkspaces,
} from '../../api/grouping'
import { getConnectionScopeKey } from '../../api/requestScope'

export function useGroupingWorkspace(library: string, refresh: () => void) {
  const scope = getConnectionScopeKey()
  const client = useQueryClient()
  const [workspace, setWorkspace] = useState<string | null>(null)
  const [after, setAfter] = useState<number | null>(null)
  const [pending, setPending] = useState<{
    operation: string
    revision: number
    intent: GroupingIntent
  } | null>(null)
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const handled = useRef<string | null>(null)
  const chosen = useRef(false)
  const lists = useQuery({
    queryKey: ['grouping-workspaces', scope, library, after],
    queryFn: ({ signal }) =>
      grouping<GroupingWorkspaces>(
        library,
        `/workspaces${after === null ? '' : `?after=${after}`}`,
        'GET',
        undefined,
        signal,
      ),
    refetchInterval: 1500,
  })
  const { refetch: refetchLists } = lists
  useEffect(() => {
    // A list cached by an earlier opening predates any Update since, so the
    // draft is chosen from this opening's own answer. A failed refresh also
    // counts as fetched, but leaves only the cached list to choose from.
    if (chosen.current || !lists.isSuccess || !lists.isFetchedAfterMount) return
    const retained = lists.data.items.find((item) => item.accepting || item.files > 0)
    const run = retained?.id ?? lists.data.available_run
    if (!run) return
    chosen.current = true
    void grouping<GroupingStatus>(library, `/workspaces/${run}`, 'POST')
      .then(() => setWorkspace(run))
      .catch((reason: Error) => {
        chosen.current = false
        setError(reason.message)
      })
  }, [library, lists.data, lists.isSuccess, lists.isFetchedAfterMount])
  const status = useQuery({
    queryKey: ['grouping-status', scope, library, workspace],
    queryFn: ({ signal }) =>
      grouping<GroupingStatus>(library, `/workspaces/${workspace}`, 'GET', undefined, signal),
    enabled: workspace !== null,
    refetchInterval: 500,
  })
  const { refetch: refetchStatus } = status
  const commandId = pending?.operation ?? status.data?.command ?? null
  const command = useQuery({
    queryKey: ['grouping-command', scope, library, commandId],
    queryFn: ({ signal }) =>
      grouping<GroupingCommand>(library, `/commands/${commandId}`, 'GET', undefined, signal),
    enabled: commandId !== null,
    refetchInterval: commandId ? 300 : false,
    retry: false,
  })
  useEffect(() => {
    const result = command.data
    if (!result || handled.current === result.id || !['succeeded', 'failed'].includes(result.state))
      return
    handled.current = result.id
    void Promise.all([refetchStatus(), refetchLists()]).then(() => {
      setError(
        result.state === 'failed'
          ? (result.error ?? 'The grouping edit was refused; your draft is retained.')
          : '',
      )
      setPending(null)
    })
    void client.invalidateQueries({ queryKey: ['grouping-tree', scope, library, workspace] })
  }, [command.data, refetchStatus, refetchLists, client, scope, library, workspace])
  async function send(value: NonNullable<typeof pending>) {
    if (!workspace) return
    setSending(true)
    setError('')
    try {
      await grouping(library, `/workspaces/${workspace}/commands`, 'POST', value)
      void client.invalidateQueries({
        queryKey: ['grouping-command', scope, library, value.operation],
      })
    } catch (reason) {
      // Retain this exact operation and intent when the reply is uncertain.
      setError((reason as Error).message)
    } finally {
      setSending(false)
    }
  }
  function edit(intent: GroupingIntent) {
    if (!status.data || pending || sending || status.data.state !== 'ready') return
    const value = { operation: operationId(), revision: status.data.revision, intent }
    setPending(value)
    void send(value)
  }
  async function choose(run: string) {
    if (pending || sending) return
    setSending(true)
    try {
      await grouping(library, `/workspaces/${run}`, 'POST')
      setWorkspace(run)
      setError('')
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setSending(false)
    }
  }
  const reviewId = status.data?.accepting ?? null
  const review = useQuery({
    queryKey: ['grouping-review', scope, library, reviewId],
    queryFn: ({ signal }) =>
      discovery<DiscoveryReview>(library, `/reviews/${reviewId}`, 'GET', undefined, signal),
    enabled: reviewId !== null,
    refetchInterval: 500,
  })
  const { refetch: refetchReview } = review
  const verificationId = command.data?.result?.verification ?? null
  const verification = useQuery({
    queryKey: ['grouping-verification', scope, library, verificationId],
    queryFn: ({ signal }) =>
      discovery<DiscoveryVerification>(
        library,
        `/verifications/${verificationId}`,
        'GET',
        undefined,
        signal,
      ),
    enabled: verificationId !== null,
    refetchInterval: 500,
  })
  const notified = useRef<string | null>(null)
  const priorReview = useRef<string | null>(null)
  useEffect(() => {
    const previous = priorReview.current
    priorReview.current = reviewId
    if (previous && !reviewId && notified.current !== previous) {
      notified.current = previous
      refresh()
    }
  }, [reviewId, refresh])
  useEffect(() => {
    if (review.data?.state !== 'applied' || notified.current === review.data.id) return
    notified.current = review.data.id
    refresh()
  }, [review.data, refresh])
  const accept = useCallback(async () => {
    if (!review.data?.receipt || review.data.state !== 'ready' || sending) return
    setSending(true)
    setError('')
    try {
      await discovery(library, `/reviews/${review.data.id}/accept`, 'POST', {
        receipt: review.data.receipt,
      })
      void refetchReview()
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setSending(false)
    }
  }, [library, review.data, refetchReview, sending])
  async function cancelVerification() {
    if (!verificationId) return
    setSending(true)
    try {
      await discovery(library, `/verifications/${verificationId}`, 'DELETE')
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setSending(false)
    }
  }
  async function resume() {
    if (!commandId || sending) return
    setSending(true)
    setError('')
    try {
      await grouping(library, `/commands/${commandId}/retry`, 'POST')
      void command.refetch()
      void refetchStatus()
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setSending(false)
    }
  }
  return {
    library,
    scope,
    workspace,
    lists,
    after,
    setAfter,
    status,
    review,
    command,
    verification,
    pending,
    sending,
    error,
    edit,
    choose,
    accept,
    cancelVerification,
    resume,
    retry: () => pending && void send(pending),
    busy:
      sending ||
      pending !== null ||
      status.data?.state !== 'ready' ||
      Boolean(status.data?.command),
  }
}

export type GroupingWorkspaceState = ReturnType<typeof useGroupingWorkspace>

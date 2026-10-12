import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import {
  conversionServing,
  conversionTask,
  retryConversion,
  startConversion,
  type ConversionHistory,
  type ConversionRequest,
  type ConversionTask,
} from '../api/libraryConversion'
import { useScopedMutation, useScopedQueryClient } from '../api/useScopedMutation'

function useTask(id: string | null) {
  return useQuery({
    queryKey: ['library-conversion', id],
    queryFn: ({ signal }) => conversionTask(id!, signal),
    enabled: id !== null,
    retry: false,
    refetchInterval: (query) =>
      ['queued', 'running'].includes(query.state.data?.state ?? '') ? 500 : false,
  })
}

/** Keep one review bound to its server tasks, including a lost activation reply. */
export function useLibraryConversion(
  initialRoot: string | null,
  history: ConversionHistory,
  remember: (value: ConversionHistory) => void,
  onOpen: (library: string) => void,
) {
  const task = useTask(history.task)
  const preparation = useTask(history.preparation)
  const activation = useTask(history.activation)
  const qc = useScopedQueryClient(false)
  const accepted = (row: ConversionTask) => qc.setQueryData(['library-conversion', row.id], row)
  const start = useScopedMutation(
    {
      mutationFn: startConversion,
      onSuccess: accepted,
      // The first read can precede server acceptance. Recheck even if its reply was lost.
      onSettled: async (_row, _error, input) => {
        const queryKey = ['library-conversion', input.operation]
        await qc.cancelQueries({ queryKey })
        await qc.invalidateQueries({ queryKey })
      },
    },
    false,
  )
  const retry = useScopedMutation({ mutationFn: retryConversion, onSuccess: accepted }, false)
  const serving = useScopedMutation(
    {
      mutationFn: ({ library, action }: { library: string; action: 'release' | 'reopen' }) =>
        conversionServing(library, action),
      onSuccess: (_row, input) => {
        void qc.invalidateQueries({ queryKey: ['library-ownership', input.library] })
        if (input.action === 'reopen') onOpen(input.library)
      },
    },
    false,
  )
  const current = task.data
  const review = preparation.data?.state === 'succeeded' ? preparation.data.result : null
  const root = current?.root_path ?? preparation.data?.root_path ?? initialRoot
  const restored = current?.action === 'undo' && current.state === 'succeeded'
  const converted =
    !restored && activation.data?.state === 'succeeded' ? activation.data.result : null
  const inspection =
    review?.inspection ?? (current?.action === 'inspect' ? current.result?.inspection : null)
  const running = current?.state === 'queued' || current?.state === 'running'
  const busy = Boolean(running || start.isPending || retry.isPending || serving.isPending)
  const swapping = Boolean(
    (start.isPending || retry.isPending || running) &&
    ['activate', 'undo'].includes(current?.action ?? start.variables?.action ?? ''),
  )

  useEffect(() => {
    if (current?.state === 'succeeded' && ['activate', 'undo'].includes(current.action))
      void qc.invalidateQueries({ queryKey: ['libraries'] })
  }, [current?.state, current?.action, qc])

  const begin = (action: ConversionRequest['action'], confirmed = false) => {
    if (!root || busy) return
    if ((action === 'activate' || action === 'undo') && (!review?.receipt || !history.preparation))
      return
    const operation = crypto.randomUUID().replaceAll('-', '')
    const next =
      action === 'inspect'
        ? { task: operation, preparation: null, activation: null }
        : {
            ...history,
            task: operation,
            ...(action === 'prepare' ? { preparation: operation, activation: null } : {}),
            ...(action === 'activate' ? { activation: operation } : {}),
          }
    // Persist the identity before the request. Reloads look up the accepted server task.
    remember(next)
    start.mutate({
      operation,
      action,
      root_path: root,
      ...(action === 'activate' || action === 'undo'
        ? { attempt: history.preparation!, receipt: review!.receipt! }
        : {}),
      confirm_stale_lease: action === 'activate' && confirmed,
    })
  }

  const error =
    current?.error ??
    (current ? null : start.error?.message) ??
    retry.error?.message ??
    serving.error?.message ??
    task.error?.message ??
    preparation.error?.message ??
    activation.error?.message
  return {
    task,
    preparation,
    current,
    root,
    review,
    inspection,
    restored,
    converted,
    busy,
    swapping,
    error,
    begin,
    retry: () => history.task && retry.mutate(history.task),
    refresh: () => void task.refetch(),
    open: () =>
      converted?.library_id && serving.mutate({ library: converted.library_id, action: 'reopen' }),
    release: () =>
      converted?.library_id && serving.mutate({ library: converted.library_id, action: 'release' }),
  }
}

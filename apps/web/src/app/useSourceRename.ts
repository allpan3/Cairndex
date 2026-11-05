import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { operationId } from '../api/catalog'
import { fetchWriteMode } from '../api/client'
import { sourceRequest, type SourceJob, type SourceRequest } from '../api/sourceOperations'

/** Inline names prepare the same exact review as File Operations; Apply stays explicit. */
export function useSourceRename(
  library: string,
  available: boolean,
  onError: (message: string) => void,
) {
  const cache = useQueryClient()
  const permission = useQuery({
    queryKey: ['source-write-mode', library],
    queryFn: () => fetchWriteMode(library),
    enabled: available,
  })
  const enabled = available && permission.data?.effective === true
  const prepare = useMutation({
    mutationFn: (request: SourceRequest) => sourceRequest<SourceJob>(library, '', 'POST', request),
    onSuccess: (job) => {
      cache.setQueryData(['source-operation', library, job.id], job)
      void cache.invalidateQueries({ queryKey: ['source-operations', library] })
    },
  })
  const queue = (request: SourceRequest) => {
    if (enabled && !prepare.isPending) prepare.mutate(request)
  }
  return {
    enabled,
    prepare,
    queue,
    rename: enabled
      ? (path: string, newName: string) => {
          const name = newName.trim()
          if (!name || name === path.split('/').at(-1)) return
          if (name === '.' || name === '..' || /[/\\]/.test(name) || name.includes('\0')) {
            onError('Enter a name without folder separators.')
            return
          }
          queue({
            operation: operationId(),
            action: 'rename',
            source: path,
            destination: path.slice(0, path.lastIndexOf('/') + 1) + name,
            collision: 'fail',
          })
        }
      : undefined,
  }
}

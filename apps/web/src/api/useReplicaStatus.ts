import { useQuery } from '@tanstack/react-query'
import { replicaRequest, type ReplicaStatus } from './replicas'

// One status query per library. The workspace polls it; other surfaces read its
// capability versions so an older server keeps unsupported controls hidden.
export function useReplicaStatus(
  library: string | null | undefined,
  refetchInterval: number | false = false,
) {
  return useQuery({
    queryKey: ['catalog-status', library],
    queryFn: () => replicaRequest<ReplicaStatus>(library!, '/status'),
    enabled: Boolean(library),
    staleTime: 1000,
    refetchInterval,
  })
}

import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { replicaRequest } from '../api/replicas'

/** Record an actual album/viewer opening, independently of metadata polling. */
export function useCatalogHistory(library: string, bundle: string | undefined, enabled: boolean) {
  const client = useQueryClient()
  const [error, setError] = useState('')
  useEffect(() => {
    if (!enabled || !bundle) return
    let active = true
    void replicaRequest(library, `/media/bundles/${bundle}/opened`, 'POST')
      .then(() => {
        if (!active) return
        setError('')
        void client.invalidateQueries({ queryKey: ['catalog-browse', library] })
      })
      .catch(() => {
        if (active) setError('Could not save this opening in local history.')
      })
    return () => {
      active = false
    }
  }, [library, bundle, enabled, client])
  return error
}

import { useLayoutEffect, useRef } from 'react'
import { basisOf, rememberBasis } from '../api/editBasis'

// A review owns its first loaded plan; polls cannot reauthorize retained selections or inline drafts
export function useGroupingEditBasis(plan: { id: string } | undefined, summaries: unknown) {
  const read = useRef<{ id: string; basis: string | undefined } | null>(null)
  const source = plan ?? summaries
  const identity = plan?.id ?? ''
  useLayoutEffect(() => {
    if (source && read.current?.id !== identity)
      read.current = { id: identity, basis: basisOf(source) }
  }, [identity, source])
  useLayoutEffect(() => {
    const saved = (event: Event) => {
      const { url, basis } = (event as CustomEvent<{ url: string; basis?: string }>).detail
      const current = read.current
      if (!basis || !current?.basis || !url.includes(`/grouping/plans/${current.id}/`)) return
      const before = current.basis.split(':')
      const after = basis.split(':')
      if (before[0] !== after[0] || before[2] !== after[2]) return
      // Every plan edit guards the whole arrangement, so its own receipt acknowledges that plan
      // The original content revision remains unchanged for later apply-time content checks
      current.basis = `${before[0]}:${before[1]}:${after[2]}:${after[3]}`
    }
    window.addEventListener('cairndex:metadata-saved', saved)
    return () => window.removeEventListener('cairndex:metadata-saved', saved)
  }, [])
  return <T extends object>(variables: T): T => rememberBasis(variables, read.current?.basis)
}

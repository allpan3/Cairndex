import { commit } from './catalogOrganize'

export type BundleMemberChange = {
  change: 'move' | 'remove' | 'collapse' | 'expand'
  entity: string
  before?: string | null
  directory?: string
}

/** The displayed membership bases prevent a later gesture overwriting a peer's order. */
export function changeBundleMember(
  library: string,
  bundle: string,
  observed: Record<string, string[]>,
  change: BundleMemberChange,
  operation: string,
) {
  return commit(
    library,
    {
      action: 'bundle_member',
      bundle,
      observed,
      change: change.change,
      entity: change.entity,
      before: change.before ?? null,
      directory: change.directory ?? null,
    },
    operation,
  )
}

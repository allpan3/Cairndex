import { createContext, useContext } from 'react'

import type { EditVersion } from '../api/editBasis'
import type { Moment, MomentCreate } from '../api/client'

/** The part of a TanStack mutation that the moment surfaces call. */
export interface MomentMutation<TVariables, TData = unknown> {
  mutate(
    variables: TVariables,
    options?: { onSuccess?: (data: TData) => void; onError?: (error: Error) => void },
  ): void
  isPending: boolean
}

export interface MomentMutations {
  create: MomentMutation<MomentCreate, Moment>
  update: MomentMutation<{ momentId: string; patch: { comment: string }; version?: EditVersion }>
  remove: MomentMutation<string>
  /** Absent where the source cannot assign tags to a moment. */
  setTags?: MomentMutation<{ momentId: string; ids: string[]; before?: string[] }>
}

/**
 * Where the moment surfaces read and write a bundle's moments.
 *
 * A portable library keeps moments in its catalog, so its viewer supplies this
 * source. Without a provider, the surfaces use the legacy library API.
 */
export interface MomentSource {
  moments: Moment[]
  mutations: MomentMutations
  /** A storyboard index for this file, or null when none can be read here. */
  storyboardUrl: (fileId: string) => string | null
}

export const MomentSourceContext = createContext<MomentSource | null>(null)

export function useMomentSource(): MomentSource | null {
  return useContext(MomentSourceContext)
}

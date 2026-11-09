import type { DiscoveryCandidate } from '../api/discovery'

/** Discoveries about files already in the library, as opposed to grouping proposals */
export type FileChangeKind = 'verification' | 'repair' | 'replacement'

export function isFileChange(candidate: DiscoveryCandidate): boolean {
  return ['verification', 'repair', 'replacement'].includes(candidate.body.kind)
}

export const FILE_CHANGE_LABEL: Record<FileChangeKind, string> = {
  verification: 'Not confirmed',
  repair: 'Possibly moved',
  replacement: 'Content changed',
}

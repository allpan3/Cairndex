// Retained discovery selections remain independent of candidate pagination
export type Selection = {
  all: boolean
  exclude: string[]
  groups: string[]
  collection: string
  moves: { file: string; before: string }[]
}

// Old explicit-list drafts remain recoverable alongside all-member selections with paged exceptions
export function validSelection(body: { files: string }): boolean {
  try {
    const value: unknown = JSON.parse(body.files)
    if (Array.isArray(value)) return value.every((id) => typeof id === 'string')
    if (!value || typeof value !== 'object') return false
    const s = value as Selection
    return (
      typeof s.all === 'boolean' &&
      typeof s.collection === 'string' &&
      [s.exclude, s.groups].every(
        (list) => Array.isArray(list) && list.every((id) => typeof id === 'string'),
      ) &&
      Array.isArray(s.moves) &&
      s.moves.every((move) => typeof move.file === 'string' && typeof move.before === 'string')
    )
  } catch {
    return false
  }
}

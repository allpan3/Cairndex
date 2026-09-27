// Stored drafts must retain a bounded selection and a matching immutable command.
export function validCatalogBulkDraft(body: {
  snapshot: string
  field: string
  value: string
  command: string
  operation: string
  applying: string
  label: string
}): boolean {
  const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
  const token = (value: unknown): value is string =>
    typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)
  const bases = (value: unknown) =>
    object(value) &&
    Object.values(value).every(
      (basis) => Array.isArray(basis) && basis.every((entry) => typeof entry === 'string'),
    )
  try {
    if (!['title', 'rating'].includes(body.field) || !['', 'true'].includes(body.applying))
      return false
    if (!body.snapshot) return !body.command && !body.operation && !body.applying
    const snapshot: unknown = JSON.parse(body.snapshot)
    if (
      !object(snapshot) ||
      !Array.isArray(snapshot.items) ||
      snapshot.items.length < 1 ||
      snapshot.items.length > 100
    )
      return false
    const ids: string[] = []
    for (const item of snapshot.items) {
      if (
        !object(item) ||
        !token(item.id) ||
        !(item.title === null || typeof item.title === 'string') ||
        !(
          item.rating === null ||
          (typeof item.rating === 'number' && Number.isFinite(item.rating))
        ) ||
        typeof item.held !== 'boolean' ||
        !bases(item.observed)
      )
        return false
      ids.push(item.id)
    }
    if (new Set(ids).size !== ids.length) return false
    if (!body.operation) return !body.command && !body.applying
    if (!token(body.operation)) return false
    const command: unknown = JSON.parse(body.command)
    if (
      !object(command) ||
      command.action !== 'bulk' ||
      !Array.isArray(command.ids) ||
      JSON.stringify([...command.ids].sort()) !== JSON.stringify([...ids].sort()) ||
      !bases(command.observed)
    )
      return false
    if (command.field === 'tags' || command.field === 'collections')
      return token(command.target) && typeof command.assigned === 'boolean'
    if (command.field === 'title') return typeof command.value === 'string'
    return (
      command.field === 'rating' &&
      (command.value === null ||
        (typeof command.value === 'number' &&
          command.value >= 0 &&
          command.value <= 5 &&
          Number.isInteger(command.value * 2)))
    )
  } catch {
    return false
  }
}

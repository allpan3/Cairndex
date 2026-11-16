// Reversible organizing: which bundles a membership change really changes, read
// before it runs, and the change that puts exactly those back. Undo is an
// ordinary guarded change: it reads current bases first, like any other.
import { catalog } from './catalog'
import { setBulkMembership } from './catalogOrganize'
import type { components } from './schema'

type Choices = components['schemas']['CatalogBulkMembershipPage']
type Choice = components['schemas']['CatalogBulkMembershipChoice']
type Family = 'tags' | 'collections'

/** One membership change as it happened: only the bundles it changed. */
export interface MembershipChange {
  family: Family
  target: string
  assigned: boolean
  ids: string[]
}

// One selection request's limit; a larger change offers no Undo
const LIMIT = 100

// One destination's state for these bundles (`selection_version: 2`)
async function readChoice(
  library: string,
  ids: string[],
  family: Family,
  target: string,
): Promise<Choice> {
  const page = await catalog<Choices>(library, '/bundles/selection/memberships', 'POST', {
    ids,
    family,
    target,
  })
  const choice = page.items[0]
  const noun = family === 'tags' ? 'tag' : 'collection'
  if (!choice) throw new Error(`This ${noun} is no longer in the library.`)
  if (choice.held) throw new Error(`This ${noun} needs metadata review first.`)
  return choice
}

// The bundles among `ids` that have `target`, by halving the mixed groups: one
// read when all or none do, a few more however mixed they are
async function membersAmong(
  library: string,
  ids: string[],
  family: Family,
  target: string,
): Promise<string[]> {
  const count = (await readChoice(library, ids, family, target)).assigned_count
  if (count === 0) return []
  if (count === ids.length) return ids
  const middle = ids.length >> 1
  const halves = await Promise.all([
    membersAmong(library, ids.slice(0, middle), family, target),
    membersAmong(library, ids.slice(middle), family, target),
  ])
  return halves.flat()
}

/**
 * What adding bundles to `target`, or removing them, is about to change, so its
 * Undo touches only those: a bulk add leaves out bundles already there. Null
 * when it cannot be read (more than 100 bundles, a held or missing target); the
 * change itself then reports any problem and simply offers no Undo.
 */
export async function plannedChange(
  library: string,
  ids: string[],
  family: Family,
  target: string,
  assigned: boolean,
): Promise<MembershipChange | null> {
  if (!ids.length || ids.length > LIMIT) return null
  try {
    const members = new Set(await membersAmong(library, ids, family, target))
    return { family, target, assigned, ids: ids.filter((id) => members.has(id) !== assigned) }
  } catch {
    return null
  }
}

/** Put changed memberships back, the last change first, so a move undone adds before it removes. */
export async function reverseChanges(library: string, changes: MembershipChange[]): Promise<void> {
  for (const change of [...changes].reverse()) {
    if (!change.ids.length) continue
    const choice = await readChoice(library, change.ids, change.family, change.target)
    if (choice.assigned_count === (change.assigned ? 0 : change.ids.length)) continue
    await setBulkMembership(library, change.ids, change.family, choice, !change.assigned)
  }
}

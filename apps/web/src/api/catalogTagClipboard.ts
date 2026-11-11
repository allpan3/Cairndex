import { catalog } from './catalog'
import { SELECTION_REQUEST } from './catalogBulk'
import { setBulkMembership } from './catalogOrganize'
import { captureRequestScope, getConnectionScopeKey, requestScopeVersion } from './requestScope'
import type { components } from './schema'

type Page = components['schemas']['CatalogMembershipPage']
type BulkPage = components['schemas']['CatalogBulkMembershipPage']
let clipboard: { scope: string; tags: string[] } | null = null
const scope = (library: string) =>
  JSON.stringify([getConnectionScopeKey() ?? requestScopeVersion(false), library])

export function copiedCatalogTags(library: string): string[] {
  return clipboard?.scope === scope(library) ? [...clipboard.tags] : []
}

/** Copy the complete assigned set, including tags beyond the inspector's first page. */
export async function copyCatalogTags(library: string, bundle: string): Promise<number> {
  const current = captureRequestScope()
  const tags: string[] = []
  let after = ''
  do {
    const page = await catalog<Page>(
      library,
      `/bundles/${bundle}/memberships/tags?${new URLSearchParams({ assigned: 'true', limit: '50', after })}`,
    )
    current()
    if (page.items.some((item) => item.held))
      throw new Error('These tags need metadata review first.')
    tags.push(...page.items.map((item) => item.id))
    after = page.next_cursor ?? ''
  } while (after)
  clipboard = { scope: scope(library), tags: [...new Set(tags)] }
  return clipboard.tags.length
}

/** Union tags through existing guarded saves; an interrupted paste only adds memberships. */
export async function pasteCatalogTags(library: string, ids: string[]): Promise<number> {
  if (!ids.length) throw new Error('Choose at least one bundle.')
  const tags = copiedCatalogTags(library)
  if (!tags.length) return 0
  const current = captureRequestScope()
  for (const target of tags) {
    current()
    // A larger selection adds each tag as a bulk operation, one after another
    if (ids.length > SELECTION_REQUEST) {
      await setBulkMembership(library, ids, 'tags', { id: target, observed: {} }, true)
      continue
    }
    const page = await catalog<BulkPage>(library, '/bundles/selection/memberships', 'POST', {
      ids,
      family: 'tags',
      target,
    })
    current()
    const choice = page.items.find((item) => item.id === target)
    if (!choice || choice.held)
      throw new Error(
        'A copied tag is unavailable or needs metadata review. Earlier additions are retained.',
      )
    if (choice.assigned_count !== ids.length)
      await setBulkMembership(library, ids, 'tags', choice, true)
    current()
  }
  return tags.length
}

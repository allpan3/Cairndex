// One-gesture collection changes from the portable browser's context menu. Each
// write reads the catalog's current bases first, so a change made on another
// device since is refused for review instead of overwritten.
import { catalog, operationId, runJob, type Entity } from './catalog'
import type { components } from './schema'

type Choices = components['schemas']['CatalogBulkMembershipPage']

const REVIEW = 'This collection needs metadata review first.'

/** Remove bundles from one collection; needs `selection_version: 2`. */
export async function removeFromCollection(
  library: string,
  ids: string[],
  collection: string,
): Promise<void> {
  const page = await catalog<Choices>(library, '/bundles/selection/memberships', 'POST', {
    ids,
    family: 'collections',
    target: collection,
  })
  const choice = page.items[0]
  if (!choice || choice.held) throw new Error(REVIEW)
  if (choice.assigned_count === 0) return
  // The menu gesture is the review, so the preview commits at once
  const prepared = await runJob(
    library,
    'preview',
    {
      action: 'bulk',
      ids,
      field: 'collections',
      target: collection,
      assigned: false,
      observed: choice.observed,
    },
    operationId(),
  )
  await runJob(
    library,
    'commit_preview',
    { job: prepared.id, receipt: prepared.receipt },
    `commit_${prepared.id}`,
  )
}

/** Make a bundle the cover of a collection whose tree holds it. */
export async function setCollectionCover(
  library: string,
  collection: string,
  bundle: string,
): Promise<void> {
  const [owner, target] = await Promise.all([
    catalog<Entity>(library, `/entities/collections/${collection}`),
    catalog<Entity>(library, `/entities/asset_bundles/${bundle}`),
  ])
  const cover = owner.fields.cover_bundle_id
  const alive = owner.fields.$alive
  const member = target.fields.$alive
  if (!cover || cover.held || alive?.value !== 'true' || alive.held) throw new Error(REVIEW)
  if (member?.value !== 'true' || member.held)
    throw new Error('This bundle needs metadata review first.')
  // The cover is a reference, so the save also touches the bundle's lifetime
  await runJob(
    library,
    'save',
    {
      changes: [
        { unit: cover.unit, value: JSON.stringify(bundle), basis: cover.basis },
        { unit: alive.unit, value: 'true', basis: alive.basis },
        { unit: member.unit, value: 'true', basis: member.basis },
      ],
      parents: owner.parents,
      resolve: false,
      recover: false,
    },
    operationId(),
  )
}

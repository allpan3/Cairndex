// One-gesture collection changes from the portable browser's menus and drags.
// Each write reads the catalog's current bases first, so a change made on another
// device since is refused for review instead of overwritten.
import { catalog, operationId, runJob, type Entity } from './catalog'
import { catalogNavigation } from './catalogQuery'
import type { CollectionRead, TagGroupRead, TagRead } from './client'
import type { components } from './schema'

type Choices = components['schemas']['CatalogBulkMembershipPage']

const REVIEW = 'This collection needs metadata review first.'

type Named = 'collections' | 'tags' | 'tag_groups'
const NOUN: Record<Named, string> = {
  collections: 'collection',
  tags: 'tag',
  tag_groups: 'tag group',
}

/** One collection's place in the shared `collections/_/$forest` arrangement. */
export interface ForestItem {
  id: string
  parent_id: string | null
  sort_order: number
}

// The menu or drag gesture is the review, so a preview commits at once
async function commit(library: string, command: unknown): Promise<void> {
  const prepared = await runJob(library, 'preview', command, operationId())
  await runJob(
    library,
    'commit_preview',
    { job: prepared.id, receipt: prepared.receipt },
    `commit_${prepared.id}`,
  )
}

/** Add bundles to, or remove them from, one collection; needs `selection_version: 2`. */
export async function setCollectionMembership(
  library: string,
  ids: string[],
  collection: string,
  assigned: boolean,
): Promise<void> {
  if (ids.length > 100) throw new Error('Choose at most 100 bundles at a time.')
  const page = await catalog<Choices>(library, '/bundles/selection/memberships', 'POST', {
    ids,
    family: 'collections',
    target: collection,
  })
  const choice = page.items[0]
  if (!choice || choice.held) throw new Error(REVIEW)
  if (choice.assigned_count === (assigned ? ids.length : 0)) return
  await commit(library, {
    action: 'bulk',
    ids,
    field: 'collections',
    target: collection,
    assigned,
    observed: choice.observed,
  })
}

/**
 * Add bundles to `target` and, for a move, remove them from `source`. These are two
 * commits, so a refused removal leaves the bundles in both collections, never in neither.
 */
export async function moveBundlesToCollection(
  library: string,
  ids: string[],
  target: string,
  source: string | null,
): Promise<void> {
  await setCollectionMembership(library, ids, target, true)
  if (source && source !== target) await setCollectionMembership(library, ids, source, false)
}

/**
 * Delete bundles in one commit; needs `browse_version: 5`. Each file of a bundle
 * returns to Unbundled with its identity and moments, and no source file changes.
 */
export function deleteBundles(library: string, ids: string[]): Promise<void> {
  if (ids.length > 100) throw new Error('Choose at most 100 bundles at a time.')
  return commit(library, { action: 'dissolve', ids })
}

/**
 * Move bundles in front of `before` (null: the end) in one collection's manual
 * order, or the global one without a collection; needs `browse_version: 6`.
 */
export function reorderBundles(
  library: string,
  collection: string | null,
  moved: string[],
  before: string | null,
): Promise<void> {
  return commit(library, { action: 'order', collection, moved, before })
}

/** Rewrite one scope's manual order from a sort; needs `browse_version: 6`. */
export function cleanUpBundleOrder(
  library: string,
  collection: string | null,
  sort: 'title' | 'rating' | 'date_added' | 'file_count',
  descending: boolean,
): Promise<void> {
  return commit(library, { action: 'order', collection, sort, descending })
}

/**
 * Create a collection holding every bundle with a file in `directory` or beneath
 * it, in one commit; needs `browse_version: 7`. Reports what the commit added.
 */
export async function collectionFromFolder(
  library: string,
  directory: string,
  name: string,
  parent: string | null,
): Promise<{ collection: CollectionRead; bundles_added: number }> {
  const prepared = await runJob(
    library,
    'preview',
    { action: 'collect_directory', directory, name, parent },
    operationId(),
  )
  // A preview's result is its receipt. Its own changes, not the lifetime guards it
  // adds for the parent and the bundles, are the new collection and its edges.
  const receipt = prepared.result as unknown as {
    changes: { unit: string; cohort: string | null }[]
  }
  const units = receipt.changes
    .filter((change) => change.cohort === 'domain' && change.unit.endsWith('/$alive'))
    .map((change) => change.unit)
  const id = units.find((unit) => unit.startsWith('collections/'))?.split('/')[1]
  if (!id) throw new Error('The collection could not be created.')
  await runJob(
    library,
    'commit_preview',
    { job: prepared.id, receipt: prepared.receipt },
    `commit_${prepared.id}`,
  )
  return {
    collection: { id, name: name.trim(), parent_id: parent } as CollectionRead,
    bundles_added: units.filter((unit) => unit.startsWith('asset_bundle_collections/')).length,
  }
}

/**
 * Bundle Unbundled files, as legacy manual bundling did: into a new confirmed
 * bundle when `target` is null, else into that confirmed bundle. Needs
 * `browse_version: 9`; returns the bundle's id.
 */
export async function bundleFiles(
  library: string,
  files: string[],
  target: string | null,
  title: string | null = null,
): Promise<string> {
  const prepared = await runJob(
    library,
    'preview',
    { action: 'bundle_files', files, target, title },
    operationId(),
  )
  // A new bundle is the one whose grouping state the receipt confirms
  const receipt = prepared.result as unknown as { changes: { unit: string }[] }
  const id =
    target ??
    receipt.changes
      .find((change) => /^asset_bundles\/[^/]+\/grouping_state$/.test(change.unit))
      ?.unit.split('/')[1]
  if (!id) throw new Error('The bundle could not be created.')
  await runJob(
    library,
    'commit_preview',
    { job: prepared.id, receipt: prepared.receipt },
    `commit_${prepared.id}`,
  )
  return id
}

/** Create an empty confirmed bundle, as legacy Create Bundle… did; returns its id. */
export async function createEmptyBundle(library: string, title: string | null): Promise<string> {
  const { cells: template } = await catalog<{ cells: Record<string, string> }>(
    library,
    '/creation/asset_bundles',
  )
  const cells: Record<string, string> = {
    ...template,
    title: JSON.stringify(title),
    grouping_state: JSON.stringify('CONFIRMED'),
    grouping_source: JSON.stringify('MANUAL'),
    // The server's creation time is also the moment the owner confirmed it
    confirmed_at: template.created_at ?? JSON.stringify(null),
  }
  await commit(library, { action: 'create', family: 'asset_bundles', cells })
  return JSON.parse(template.id ?? 'null') as string
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

// The server assigns the identity and timestamps of a new catalog row
async function createNamed<T>(
  library: string,
  family: Named,
  values: Record<string, unknown>,
): Promise<T> {
  const template = await catalog<{ cells: Record<string, string> }>(library, `/creation/${family}`)
  const cells = { ...template.cells }
  for (const [column, value] of Object.entries(values)) cells[column] = JSON.stringify(value)
  await commit(library, { action: 'create', family, cells })
  return Object.fromEntries(
    Object.entries(cells).map(([column, raw]) => [column, JSON.parse(raw) as unknown]),
  ) as T
}

/** Create a collection at the end of its parent's children; returns the new row. */
export function createCollection(
  library: string,
  name: string,
  parent: string | null,
  sortOrder: number,
): Promise<CollectionRead> {
  return createNamed(library, 'collections', { name, parent_id: parent, sort_order: sortOrder })
}

/** Create a tag at the end of its parent's children; returns the new row. */
export function createTag(
  library: string,
  name: string,
  parent: string | null,
  sortOrder: number,
): Promise<TagRead> {
  return createNamed(library, 'tags', { name, parent_id: parent, sort_order: sortOrder })
}

/** Create a tag group after the others; returns the new row. */
export function createTagGroup(
  library: string,
  name: string,
  sortOrder: number,
): Promise<TagGroupRead> {
  return createNamed(library, 'tag_groups', { name, sort_order: sortOrder })
}

/** Rename a collection, tag or tag group whose name this device has seen. */
export async function rename(
  library: string,
  family: Named,
  id: string,
  name: string,
): Promise<void> {
  const entity = await catalog<Entity>(library, `/entities/${family}/${id}`)
  const field = entity.fields.name
  const alive = entity.fields.$alive
  if (!field || field.held || alive?.value !== 'true' || alive.held)
    throw new Error(`This ${NOUN[family]} needs metadata review first.`)
  await runJob(
    library,
    'save',
    {
      changes: [
        { unit: field.unit, value: JSON.stringify(name), basis: field.basis },
        { unit: alive.unit, value: 'true', basis: alive.basis },
      ],
      parents: entity.parents,
      resolve: false,
      recover: false,
    },
    operationId(),
  )
}

/**
 * Delete one collection, tag or tag group; bundles keep everything else. Without
 * `cascade`, children move up one level; with it, the whole subtree goes.
 */
export function remove(library: string, family: Named, id: string, cascade = false) {
  return commit(library, { action: 'delete', family, entity: id, cascade })
}

/** Add a tag to a tag group, or remove it; needs `browse_version: 8`. */
/**
 * What deleting a tag with its descendants takes: the tags, and the bundles that
 * carry any. It reads the current catalog, not the page's copy, so the prompt
 * cannot understate a subtree that changed a moment ago.
 */
export async function tagDeleteImpact(
  library: string,
  id: string,
): Promise<{ tags: number; bundles: number }> {
  // Each navigation row counts the bundles carrying the tag or a descendant
  type Counted = Pick<TagRead, 'id' | 'parent_id'> & { count: number }
  const tags = await catalogNavigation<Counted>(library, 'tags')
  const children = new Map<string, string[]>()
  for (const tag of tags)
    if (tag.parent_id) children.set(tag.parent_id, [...(children.get(tag.parent_id) ?? []), tag.id])
  const subtree = new Set([id])
  for (const member of subtree) for (const child of children.get(member) ?? []) subtree.add(child)
  return { tags: subtree.size, bundles: tags.find((tag) => tag.id === id)?.count ?? 0 }
}

export function groupTag(library: string, group: string, tag: string, assigned: boolean) {
  return commit(library, { action: 'group_tag', group, tag, assigned })
}

/**
 * Rewrite a collection or tag hierarchy from the catalog's current arrangement,
 * never from the browser's older copy, so the change applies to what another
 * device left.
 */
export async function arrangeHierarchy(
  library: string,
  family: 'collections' | 'tags',
  change: (items: ForestItem[]) => ForestItem[],
): Promise<void> {
  const entity = await catalog<Entity>(library, `/entities/${family}/_`)
  const forest = entity.fields.$forest
  if (!forest || forest.held)
    throw new Error(`The ${NOUN[family]} order needs metadata review first.`)
  const items = JSON.parse(forest.value ?? '[]') as ForestItem[]
  await commit(library, { action: 'arrange', unit: forest.unit, value: change(items) })
}

// Sibling order is sort order, then name, as the sidebar draws it
function siblingOrder(names: Record<string, string>) {
  return (a: ForestItem, b: ForestItem) =>
    a.sort_order - b.sort_order || (names[a.id] ?? '').localeCompare(names[b.id] ?? '')
}

/**
 * Place `moved` under `parent` before `before` (null: at the end), keeping their
 * shown order, and renumber that one sibling group. Other groups keep their values.
 */
export function moveCollections(
  items: ForestItem[],
  names: Record<string, string>,
  moved: string[],
  parent: string | null,
  before: string | null,
): ForestItem[] {
  const order = siblingOrder(names)
  const movers = items.filter((item) => moved.includes(item.id)).sort(order)
  const siblings = items
    .filter((item) => item.parent_id === parent && !moved.includes(item.id))
    .sort(order)
  const found = before === null ? -1 : siblings.findIndex((item) => item.id === before)
  const at = found < 0 ? siblings.length : found
  const group = [
    ...siblings.slice(0, at),
    ...movers.map((item) => ({ ...item, parent_id: parent })),
    ...siblings.slice(at),
  ]
  const placed = new Map(group.map((item, index) => [item.id, { ...item, sort_order: index }]))
  return items.map((item) => placed.get(item.id) ?? item)
}

/** Order every sibling group by name, as the legacy Clean Up Order did. */
export function sortCollectionsByName(
  items: ForestItem[],
  names: Record<string, string>,
  direction: 'asc' | 'desc',
): ForestItem[] {
  const sign = direction === 'asc' ? 1 : -1
  const groups = new Map<string | null, ForestItem[]>()
  for (const item of items)
    groups.set(item.parent_id, [...(groups.get(item.parent_id) ?? []), item])
  const placed = new Map<string, ForestItem>()
  for (const group of groups.values())
    group
      .sort(
        (a, b) =>
          sign * (names[a.id] ?? '').localeCompare(names[b.id] ?? '') || a.id.localeCompare(b.id),
      )
      .forEach((item, index) => placed.set(item.id, { ...item, sort_order: index }))
  return items.map((item) => placed.get(item.id)!)
}

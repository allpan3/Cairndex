import { captureRequestScope } from './requestScope'
// Exact value text and explicit observed bases shared by every catalog editor
import { replicaRequest } from './replicas'

export type Field = {
  unit: string
  value: string | null
  basis: string[]
  candidates: { value: string; revisions: string[] }[]
  held: string | null
  components: Record<string, string>
}
export type Entity = {
  has_conflicts: boolean
  family: string
  id: string
  fields: Record<string, Field>
  observed: Record<string, string[]>
  parents: string[]
}
export type Page = { items: Entity[]; next_cursor: string | null }
export type Control = {
  field: string
  label: string
  kind: string
  nullable: boolean
  choices: string[]
  reference_family: string | null
  columns: string[]
}
export type Change = { unit: string; value: string; basis: string[] }
export type Save = { changes: Change[]; parents: string[]; resolve: boolean; recover: boolean }
export type Job = {
  action: 'save' | 'preview' | 'commit_preview' | 'recover'
  id: string
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  result: (Save & { event?: string }) | null
  error: string | null
  receipt: string | null
}
export const FAMILIES: Record<string, string> = {
  asset_bundles: 'Bundles',
  asset_files: 'Files',
  bundle_directory_members: 'Directory members',
  tags: 'Tags',
  tag_groups: 'Tag groups',
  collections: 'Collections',
  smart_folders: 'Smart Collections',
  moments: 'Moments',
  subtitle_tracks: 'Subtitle selections',
  asset_bundle_tags: 'Bundle tags',
  asset_bundle_collections: 'Collection membership',
  moment_tags: 'Moment tags',
  tag_group_memberships: 'Tag group membership',
}

// Library scope remains explicit across tab changes and asynchronous job completion
export function catalog<T>(library: string, path: string, method = 'GET', body?: unknown) {
  return replicaRequest<T>(library, `/catalog${path}`, method, body)
}

export class CatalogJobError extends Error {}

// A stable operation ID retries a completed save without producing a second authored event
export async function runJob(
  library: string,
  action: string,
  body: unknown,
  operation: string,
): Promise<Job> {
  const assertScope = captureRequestScope()
  let job = await catalog<Job>(library, '/jobs', 'POST', { action, body, operation })
  while (job.state === 'queued' || job.state === 'running') {
    await new Promise((resolve) => setTimeout(resolve, 250))
    assertScope()
    job = await catalog<Job>(library, `/jobs/${operation}`)
  }
  assertScope()
  if (job.state !== 'succeeded')
    throw new CatalogJobError(job.error ?? 'Catalog operation was cancelled')
  return job
}

// Labels prefer authored names while every row keeps its stable identity available
export function entityLabel(entity: Entity): string {
  for (const field of ['title', 'name', 'display_title', 'comment', 'label', 'directory_path']) {
    const value = entity.fields[field]?.value
    if (value && value !== 'null' && value.startsWith('"')) return JSON.parse(value) as string
  }
  return entity.id
}

// Decode only text cells; numeric and opaque JSON values retain their exact serialized text
export function displayCell(raw: string | null | undefined): string {
  if (raw == null) return 'Waiting for a valid arrangement'
  if (raw === 'null') return 'Not set'
  if (raw.startsWith('"')) return JSON.parse(raw) as string
  if (raw === 'true') return 'Keep object'
  if (raw === 'false') return 'Keep deleted'
  return raw
}

// New retry IDs are generated on intent changes, never on a retry of the same draft
export const operationId = () => crypto.randomUUID().replaceAll('-', '')

// Provenance remains available without obscuring everyday creation and editing controls
export const advancedCatalogFields = new Set([
  'id',
  'created_at',
  'updated_at',
  'imported_at',
  'confirmed_at',
  'version',
  'grouping_source',
  'grouping_state',
  'grouping_rule_version',
  'extra_metadata',
])

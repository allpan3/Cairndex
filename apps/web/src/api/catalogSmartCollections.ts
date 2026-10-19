import { catalog, type Entity } from './catalog'
import { commit } from './catalogOrganize'
import type { FilterExpression, SmartCollectionRead } from './client'

export type SmartCollectionOpening = {
  existing: SmartCollectionRead | null
  entity: Entity | null
  cells: Record<string, string>
}

async function checkResult(library: string, id: string): Promise<void> {
  const entity = await catalog<Entity>(library, `/entities/smart_folders/${id}`)
  if (entity.has_conflicts)
    throw new Error(
      'This Smart Collection has competing changes. Review metadata before continuing.',
    )
}

/** Capture the editable values and causal bases before opening ordinary controls. */
export async function openSmartCollection(
  library: string,
  id: string | null,
): Promise<SmartCollectionOpening> {
  if (!id) {
    const template = await catalog<{ cells: Record<string, string> }>(
      library,
      '/creation/smart_folders',
    )
    return { existing: null, entity: null, cells: template.cells }
  }
  const entity = await catalog<Entity>(library, `/entities/smart_folders/${id}`)
  if (
    entity.fields.$alive?.value !== 'true' ||
    Object.values(entity.fields).some((field) => field.held)
  )
    throw new Error('This Smart Collection needs metadata review first.')
  const values = Object.fromEntries(
    Object.entries(entity.fields)
      .filter(([name]) => !name.startsWith('$'))
      .map(([name, field]) => [name, JSON.parse(field.value!) as unknown]),
  )
  const filter = JSON.parse(entity.fields.$filter!.value!) as { filter_json: string }
  return {
    entity,
    cells: {},
    existing: { ...values, id, filter: JSON.parse(filter.filter_json) } as SmartCollectionRead,
  }
}

/** Reuse the opening snapshot on every retry; later polls cannot authorize an overwrite. */
export async function saveSmartCollection(
  library: string,
  opening: SmartCollectionOpening,
  name: string,
  filter: FilterExpression | null,
  operation: string,
): Promise<string> {
  if (!opening.entity) {
    if (!filter) throw new Error('Choose the Smart Collection conditions before creating it.')
    const cells: Record<string, string> = {
      ...opening.cells,
      name: JSON.stringify(name.trim()),
      filter_version: '1',
      filter_json: JSON.stringify(JSON.stringify(filter)),
    }
    await commit(library, { action: 'create', family: 'smart_folders', cells }, operation)
    const id = JSON.parse(cells.id!) as string
    await checkResult(library, id)
    return id
  }
  const entity = opening.entity
  await commit(
    library,
    {
      action: 'smart_collection',
      entity: entity.id,
      name: name.trim(),
      ...(filter ? { filter_json: JSON.stringify(filter) } : {}),
      observed: Object.fromEntries(
        (filter ? ['name', '$alive', '$filter'] : ['name', '$alive']).map((column) => {
          const field = entity.fields[column]!
          return [field.unit, field.basis]
        }),
      ),
    },
    operation,
  )
  await checkResult(library, entity.id)
  return entity.id
}

/** Deletion also guards the values the confirmation displayed. Bundles are untouched. */
export async function deleteSmartCollection(
  library: string,
  opening: SmartCollectionOpening,
  operation: string,
): Promise<void> {
  const entity = opening.entity
  if (!entity) throw new Error('Open the Smart Collection before deleting it.')
  await commit(
    library,
    {
      action: 'smart_collection',
      entity: entity.id,
      delete: true,
      observed: Object.fromEntries(
        Object.values(entity.fields).map((field) => [field.unit, field.basis]),
      ),
    },
    operation,
  )
  await checkResult(library, entity.id)
}

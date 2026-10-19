import type { SmartCollectionRead } from '../api/client'
import { type FilterDraft, emptyDraft, expressionToDraft } from './filterModel'

export type SmartCollectionInput = {
  name: string
  draft: FilterDraft | null
  conditionsEdited: boolean
}

export function smartCollectionInput(existing?: SmartCollectionRead | null): SmartCollectionInput {
  return {
    name: existing?.name ?? '',
    draft: existing ? expressionToDraft(existing.filter) : emptyDraft(),
    conditionsEdited: false,
  }
}

/** Conversion belongs to owner setup on one server, outside the metadata edit queue. */
import { getJson, sendDirect, type LibraryOwnership } from './client'
import type { components } from './schema'

export type ConversionRequest = components['schemas']['ConversionRequest']
export type ConversionTask = components['schemas']['ConversionTaskRead']
export type ConversionInspection = components['schemas']['ConversionInspectionRead']

const tasks = '/api/v1/libraries/conversions/tasks'

export const startConversion = (body: ConversionRequest) =>
  sendDirect<ConversionTask>(tasks, 'POST', body, undefined, false)

export const conversionTask = (id: string, signal?: AbortSignal) =>
  getJson<ConversionTask>(`${tasks}/${id}`, signal, false)

export const retryConversion = (id: string) =>
  sendDirect<ConversionTask>(`${tasks}/${id}/retry`, 'POST', undefined, undefined, false)

export const conversionServing = (library: string, action: 'release' | 'reopen') =>
  sendDirect<LibraryOwnership>(
    `/api/v1/libraries/${library}/ownership/${action}`,
    'POST',
    undefined,
    undefined,
    false,
  )

export type ConversionHistory = {
  task: string | null
  preparation: string | null
  activation: string | null
}

export const emptyConversion: ConversionHistory = {
  task: null,
  preparation: null,
  activation: null,
}

/** Store only operation identities. The server keeps paths, receipts and results. */
export function readConversion(key: string): ConversionHistory {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
    if (!value || typeof value !== 'object') return emptyConversion
    const ids = value as Partial<ConversionHistory>
    const valid = (id: unknown) => (typeof id === 'string' && /^[a-f0-9]{32}$/.test(id) ? id : null)
    return {
      task: valid(ids.task),
      preparation: valid(ids.preparation),
      activation: valid(ids.activation),
    }
  } catch {
    return emptyConversion
  }
}

export function saveConversion(key: string, history: ConversionHistory) {
  try {
    localStorage.setItem(key, JSON.stringify(history))
  } catch {
    // A storage failure does not cancel an accepted server task.
  }
}

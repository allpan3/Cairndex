import { getJson, send } from './client'
import type { components } from './schema'

export type RecoveryRequest = components['schemas']['RecoveryRequest']
export type RecoveryTask = components['schemas']['RecoveryTaskRead']
export type RecoveryPage = components['schemas']['RecoveryTaskPage']
const path = (library: string) => `/api/v1/libraries/${library}/private-recovery/tasks`
export const recoveryTasks = (library: string, after = '') =>
  getJson<RecoveryPage>(`${path(library)}?after=${encodeURIComponent(after)}`)
export const recoveryTask = (library: string, id: string) =>
  getJson<RecoveryTask>(`${path(library)}/${id}`)
export const startRecovery = (library: string, request: RecoveryRequest) =>
  send<RecoveryTask>(path(library), 'POST', request)
export const controlRecovery = (library: string, id: string, action: 'stop' | 'retry') =>
  send<RecoveryTask>(`${path(library)}/${id}/${action}`, 'POST')

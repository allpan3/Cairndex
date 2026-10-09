// One committed desktop connection with cancellable preparation and durable selection

import {
  configureHostServer,
  getHostPlatform,
  normalizeHostServerUrl,
  loadHostConnections,
  loadHostServerUrl,
  saveHostConnections,
  startHostLocalServer,
  type StoredConnection,
  type StoredConnections,
} from '../platform'
import { fetchLibraries, setApiBaseUrl } from '../api/client'
import { resetJobNotifications } from './useJobNotifications'
import { verifyServer } from './verifyServer'

export const LOCAL_CONNECTION_ID = 'local'
export const LOCAL_CONNECTION_LABEL = 'This Computer'

export type Connection = StoredConnection

interface ConnectionsState {
  connections: Connection[]
  activeConnectionId: string | null
}

const EMPTY: ConnectionsState = { connections: [], activeConnectionId: null }

let state: ConnectionsState = EMPTY
let listeners = new Set<() => void>()

/**
 * The activation currently running, if any.
 *
 * Keyed by target id so a repeat request for the *same* connection joins the
 * work instead of duplicating it, while a request for a *different* one is
 * refused rather than queued — queueing would eventually run a switch the user
 * has already navigated past.
 */
let inFlight: {
  id: string
  libraryUuid?: string
  promise: Promise<Connection>
  controller: AbortController
} | null = null

function notify(): void {
  for (const listener of listeners) listener()
}

export function subscribeConnections(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getConnections(): ConnectionsState {
  return state
}

export function getActiveConnection(): Connection | null {
  return state.connections.find((entry) => entry.id === state.activeConnectionId) ?? null
}

/** The label to name in "this library is not on …" style messages. */
export function activeConnectionLabel(): string {
  return getActiveConnection()?.label ?? 'this server'
}

export function localConnection(): Connection {
  return {
    id: LOCAL_CONNECTION_ID,
    kind: 'local',
    label: LOCAL_CONNECTION_LABEL,
    // Resolved at activation: the sidecar's port is ephemeral and meaningful
    // only within the current process, so persisting one would be a lie by the
    // next launch.
    serverUrl: null,
  }
}

function labelFor(serverUrl: string): string {
  try {
    return new URL(serverUrl).host || serverUrl
  } catch {
    return serverUrl
  }
}

/**
 * Load the stored connections, migrating a pre-D6 single server URL.
 *
 * Someone who already configured a NAS must see no first-run change: their
 * `serverUrl` becomes the first remote connection, already active.
 */
export async function loadConnections(): Promise<ConnectionsState> {
  const stored = await loadHostConnections()
  if (stored && stored.connections.length > 0) {
    state = normalize(stored)
    notify()
    return state
  }

  const legacy = await loadHostServerUrl()
  state = legacy
    ? {
        connections: [
          { id: 'remote:' + legacy, kind: 'remote', label: labelFor(legacy), serverUrl: legacy },
        ],
        activeConnectionId: 'remote:' + legacy,
      }
    : EMPTY
  notify()
  return state
}

// Drops an active id that names no connection, which would otherwise present as
// "connected to nothing" with no way back.
function normalize(stored: StoredConnections): ConnectionsState {
  const connections = stored.connections.filter((entry) => entry.id)
  const active =
    connections.find((entry) => entry.id === stored.activeConnectionId)?.id ??
    connections[0]?.id ??
    null
  return { connections, activeConnectionId: active }
}

/** Add a remote connection, or return the existing entry for that URL. */
export async function addRemoteConnection(serverUrl: string): Promise<Connection> {
  const existing = state.connections.find(
    (entry) => entry.kind === 'remote' && entry.serverUrl === serverUrl,
  )
  if (existing) return existing
  const connection: Connection = {
    id: 'remote:' + serverUrl,
    kind: 'remote',
    label: labelFor(serverUrl),
    serverUrl,
  }
  const next = { ...state, connections: [...state.connections, connection] }
  await saveHostConnections(next)
  state = next
  notify()
  return connection
}

/** Ensure the managed local connection exists in the set. */
export async function ensureLocalConnection(): Promise<Connection> {
  const existing = state.connections.find((entry) => entry.kind === 'local')
  if (existing) return existing
  const connection = localConnection()
  const next = { ...state, connections: [...state.connections, connection] }
  await saveHostConnections(next)
  state = next
  notify()
  return connection
}

// Reports one attempt independently of the committed connection and query scope
export interface ActivationState {
  id: string | null
  cancellable: boolean
  error: string | null
}
let activation: ActivationState = { id: null, cancellable: false, error: null }
let session = 0

// Reconnecting the same server still creates a fresh request and query scope
export function getConnectionSession(): number {
  return session
}

// Exposes progress and retry guidance without pretending an unverified target is active
export function getActivation(): ActivationState {
  return activation
}

// Cancellation during preparation leaves the current workspace and intended selection intact
export function cancelActivation(): void {
  if (activation.cancellable) inFlight?.controller.abort()
}

// Serializes attempts; repeat clicks join the same attempt and other targets remain explicit
export async function activateConnection(id: string, libraryUuid?: string): Promise<Connection> {
  if (inFlight) {
    if (inFlight.id === id && inFlight.libraryUuid === libraryUuid) return inFlight.promise
    throw new Error(
      'Another connection is already being opened. Cancel it before choosing another server.',
    )
  }
  const controller = new AbortController()
  activation = { id, cancellable: true, error: null }
  const promise = runActivation(id, controller.signal, libraryUuid)
    .catch((error: unknown) => {
      activation = {
        id: null,
        cancellable: false,
        error:
          error instanceof Error
            ? error.message
            : 'Could not connect. Retry or choose another server.',
      }
      throw error
    })
    .finally(() => {
      inFlight = null
      notify()
    })
  inFlight = { id, libraryUuid, promise, controller }
  notify()
  return promise
}

// Verifies before persisting or changing transport; a failed commit restores the stored choice
async function runActivation(
  id: string,
  signal: AbortSignal,
  libraryUuid?: string,
): Promise<Connection> {
  const target = state.connections.find((entry) => entry.id === id)
  if (!target) throw new Error('That connection is no longer configured.')
  let serverUrl: string
  let localToken: string | null = null
  if (target.kind === 'local') {
    const info = await startHostLocalServer()
    serverUrl = info.baseUrl
    localToken = info.token
  } else {
    if (!target.serverUrl) throw new Error('That connection has no server address.')
    serverUrl = target.serverUrl
    await verifyServer(serverUrl, signal)
  }
  let selectedLibrary: string | undefined
  if (libraryUuid) {
    const libraries = await fetchLibraries(signal, serverUrl)
    selectedLibrary = libraries.find((entry) => entry.library_uuid === libraryUuid)?.id
    if (!selectedLibrary)
      throw new Error(
        'The serving server does not list this library. Retry or choose a library on that server.',
      )
  }
  if (signal.aborted) throw new Error('Connection cancelled. The previous selection is unchanged.')

  // Once the short commit starts, its store and IPC operations must finish together
  activation = { id, cancellable: false, error: null }
  notify()
  const previous = state
  const next = { ...state, activeConnectionId: id }
  await saveHostConnections(next)
  try {
    // The platform commits URL, grant and relay atomically on success
    await configureHostServer(serverUrl, { localToken })
  } catch (error) {
    try {
      await saveHostConnections(previous)
    } catch {
      throw new Error(
        'Connection failed and the remembered selection could not be restored. Retry before restarting.',
        { cause: error },
      )
    }
    throw error
  }
  setApiBaseUrl(serverUrl, id)
  resetJobNotifications()
  state = next
  session += 1
  if (selectedLibrary) setPendingLibrarySelection(id, selectedLibrary)
  activation = { id: null, cancellable: false, error: null }
  notify()
  return target
}

/**
 * Where one connection's remembered library selection is stored.
 *
 * Per connection, not global. Library ids are per-server and not globally
 * unique, so a single key could carry an id from the NAS into the local server,
 * where — in the improbable case it also exists — it would silently select the
 * wrong library. The unsuffixed key is kept for the browser, which has exactly
 * one server and therefore one scope forever.
 */
export function libraryStorageKey(connectionId: string | null): string {
  return connectionId ? `cairndex.libraryId:${connectionId}` : 'cairndex.libraryId'
}

// Follows ownership to a specific server before resolving its portable library identity
export async function connectToServer(serverUrl: string, libraryUuid?: string): Promise<void> {
  const target = new URL(serverUrl)
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password)
    throw new Error('The serving address must be HTTP or HTTPS without credentials.')
  if (getHostPlatform().kind !== 'desktop') {
    if (libraryUuid) target.searchParams.set('library_uuid', libraryUuid)
    window.location.assign(target.href)
    return
  }
  const address = await normalizeHostServerUrl(serverUrl)
  const connection = await addRemoteConnection(address)
  await activateConnection(connection.id, libraryUuid)
}

/**
 * A library to select once a connection's workspace mounts.
 *
 * Activation remounts the query scope, and with it the component holding the
 * library selection — so "open this folder, then show that library" is a
 * handoff *across* a remount, not a piece of persisted state. Deliberately not
 * localStorage: that would make the outcome depend on storage being writable,
 * and it would also collide with the user's own remembered selection for the
 * connection, which should not be overwritten just because a folder was opened.
 *
 * Consumed once, by the workspace that mounts next.
 */
const pendingSelection = new Map<string, string>()

/**
 * Bumped on every queue so subscribers re-check.
 *
 * The remount alone is not enough: re-opening a folder on the connection that
 * is *already* active leaves `activeConnectionId` unchanged, so nothing
 * remounts and an effect keyed only on that id never re-runs — the second open
 * of an already-registered library would appear to do nothing at all
 * (owner-reported). This version is what makes the queue observable in its own
 * right.
 */
let pendingVersion = 0

export function getPendingSelectionVersion(): number {
  return pendingVersion
}

export function setPendingLibrarySelection(connectionId: string, libraryId: string): void {
  pendingSelection.set(connectionId, libraryId)
  pendingVersion += 1
  notify()
}

/** Take the pending selection for a connection, if one is waiting. */
export function takePendingLibrarySelection(connectionId: string | null): string | null {
  if (!connectionId) return null
  const libraryId = pendingSelection.get(connectionId) ?? null
  pendingSelection.delete(connectionId)
  return libraryId
}

/** Test-only reset, mirroring `resetHostPlatformForTests`. */
export function resetConnectionsForTests(): void {
  state = EMPTY
  activation = { id: null, cancellable: false, error: null }
  session = 0
  listeners = new Set()
  inFlight = null
  pendingSelection.clear()
  pendingIndexes.clear()
  pendingVersion = 0
}

// Hands first indexing to the destination app after a native create crosses a server switch
const pendingIndexes = new Map<string, string>()
export function queueLibraryIndex(connectionId: string, libraryId: string): void {
  pendingIndexes.set(connectionId, libraryId)
  pendingVersion += 1
  notify()
}

// Consumes only when the intended library is available on the destination
export function takeLibraryIndex(connectionId: string | null, libraryId: string): boolean {
  if (!connectionId || pendingIndexes.get(connectionId) !== libraryId) return false
  pendingIndexes.delete(connectionId)
  return true
}

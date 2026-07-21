/**
 * The desktop connections model (plan 3 §7.1, ADR-0018 §5).
 *
 * The shell used to know exactly one server URL. It now knows a set of
 * connections — remote servers plus one managed local server — with **exactly
 * one active at a time**. Switching, not simultaneous browsing: the media relay
 * is single-config by design, deep-link classification is built around "not on
 * this server", and ADR-0018 already guarantees one server per library, so
 * simultaneity would buy breadth of view at the cost of multiplying all three.
 *
 * Two properties this module exists to guarantee, both easy to get wrong:
 *
 * - **Activation is all-or-nothing.** Every fallible step runs before anything
 *   user-visible changes. A half-switch — new URL against an old cache, or the
 *   reverse — is worse than either endpoint, because every request afterwards
 *   looks plausible and is wrong.
 * - **Only one activation runs at a time.** A menu double-click or a StrictMode
 *   double-effect is the same race the shell's `start_once` had to fix.
 */

import {
  configureHostServer,
  loadHostConnections,
  loadHostServerUrl,
  saveHostConnections,
  startHostLocalServer,
  type StoredConnection,
  type StoredConnections,
} from '../platform'
import { resetJobNotifications } from './useJobNotifications'

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
let inFlight: { id: string; promise: Promise<Connection> } | null = null

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

async function persist(): Promise<void> {
  await saveHostConnections({
    // The local connection is re-derived each session, so persisting its (null)
    // URL is harmless, but persisting a token would not be — there is none here
    // to persist by construction.
    connections: state.connections,
    activeConnectionId: state.activeConnectionId,
  })
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
  state = { ...state, connections: [...state.connections, connection] }
  await persist()
  notify()
  return connection
}

/** Ensure the managed local connection exists in the set. */
export async function ensureLocalConnection(): Promise<Connection> {
  const existing = state.connections.find((entry) => entry.kind === 'local')
  if (existing) return existing
  const connection = localConnection()
  state = { ...state, connections: [...state.connections, connection] }
  await persist()
  notify()
  return connection
}

/**
 * Make one connection the active one, or leave everything exactly as it was.
 *
 * Ordering is the point. Resolving the URL and reconfiguring transport are the
 * steps that can fail, and both run before `activeConnectionId` moves; the
 * commit itself cannot fail. On failure the previous connection is restored —
 * including a media-relay reconfigure, which is the one step with an effect
 * outside this module's state and so the only thing needing compensation.
 */
export async function activateConnection(id: string): Promise<Connection> {
  if (inFlight) {
    if (inFlight.id === id) return inFlight.promise
    throw new Error('Another connection is already being opened.')
  }
  const promise = runActivation(id).finally(() => {
    inFlight = null
  })
  inFlight = { id, promise }
  return promise
}

async function runActivation(id: string): Promise<Connection> {
  const target = state.connections.find((entry) => entry.id === id)
  if (!target) throw new Error('That connection is no longer configured.')

  const previous = getActiveConnection()

  // --- fallible steps, before anything user-visible moves -------------------
  let serverUrl: string
  let localToken: string | null = null
  if (target.kind === 'local') {
    const info = await startHostLocalServer()
    serverUrl = info.baseUrl
    localToken = info.token
  } else {
    if (!target.serverUrl) throw new Error('That connection has no server address.')
    serverUrl = target.serverUrl
  }

  try {
    await configureHostServer(serverUrl, { localToken })
  } catch (error) {
    await restore(previous)
    throw error
  }

  // --- commit: nothing below can fail --------------------------------------
  // Run state is module-scoped by D5b design (so a Workspace remount does not
  // drop a run in flight), which is exactly why a *connection* switch has to
  // clear it: a run started on the previous server would otherwise settle here
  // and notify about work the user is no longer looking at.
  resetJobNotifications()
  state = {
    connections: state.connections.map((entry) =>
      entry.id === id
        ? { ...entry, serverUrl: entry.kind === 'local' ? null : entry.serverUrl }
        : entry,
    ),
    activeConnectionId: id,
  }
  notify()
  void persist()
  return target
}

// Re-points transport at the connection that was active before a failed switch.
// Reconfiguring rotates the media relay's capability route, so without this the
// previous connection would survive with dead media URLs.
async function restore(previous: Connection | null): Promise<void> {
  if (!previous?.serverUrl) return
  try {
    await configureHostServer(previous.serverUrl)
  } catch {
    // Nothing better to do: the switch already failed, and reporting a second
    // failure over the first would only obscure the cause.
  }
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

export function setPendingLibrarySelection(connectionId: string, libraryId: string): void {
  pendingSelection.set(connectionId, libraryId)
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
  listeners = new Set()
  inFlight = null
  pendingSelection.clear()
}

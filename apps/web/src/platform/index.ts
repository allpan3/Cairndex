import type { DesktopMenuAction } from '../desktop/types'
import { webPlatform } from './web'

// Describes one library-relative file exported through a host operation
export interface DragOutItem {
  libraryId: string
  relativePath: string
}

// Outcome of reverse-mapping Finder-dropped absolute paths against one library,
// categorized per dropped path (plan 3 §6). `inside` holds library-relative paths
// for regular files under the mapped root (offered to the fast-add flow).
// `outside` echoes the dropped ABSOLUTE paths of regular files outside the root, so
// the W5 copy-in seam can act on exactly that subset — these are the caller's own
// input strings, not new library-internal paths, so echoing them leaks nothing.
// `directories` counts dropped folders (folders aren't recursed yet).
export interface ReverseMapResult {
  inside: string[]
  outside: string[]
  directories: number
}

// One upload-progress tick for a dropped file being copied in (plan 4 W5).
// `path` is the dropped file's absolute path, which the web layer already holds,
// so it can match a tick to the file it is showing progress for.
export interface ImportProgressEvent {
  path: string
  sent: number
  total: number
}

// Defines the complete web-versus-native host boundary from plan 3 section 4
export interface HostPlatform {
  kind: 'web' | 'desktop'
  canRevealInFinder: boolean
  canOpenWithDefaultApp: boolean
  canDragOutFiles: boolean
  // True when the host can put a generated artifact where the user chooses
  // (plan 1 §10 / M11). The browser can only trigger an ordinary download.
  canSaveExports: boolean
  revealFile(libraryId: string, relativePath: string): Promise<void>
  openFile(libraryId: string, relativePath: string): Promise<void>
  startFileDrag(items: DragOutItem[]): Promise<void>
  getLibraryMapping(libraryId: string): Promise<string | null>
  locateLibrary(libraryId: string, libraryUuid: string): Promise<string | null>
  clearLibraryMapping(libraryId: string): Promise<void>
  /**
   * Saves an export artifact through the native save dialog (M11 seam; no export
   * UI exists yet). Resolves to the chosen path, or null when the user cancelled.
   * The caller supplies bytes and a suggested file *name* — never a path, so the
   * destination can only come from the OS dialog.
   */
  saveExport(suggestedName: string, bytes: Uint8Array): Promise<string | null>
}

/** The running local-server sidecar (plan 3 D6). */
export interface LocalServerInfo {
  baseUrl: string
  /**
   * Bearer for every request to the sidecar. Server-wide rather than
   * library-scoped, and regenerated per start, so it is never persisted.
   */
  token: string
}

/** The outcome of picking a library folder. Ids only — never a path. */
export interface OpenedLibrary {
  /**
   * True when the picked folder is not a Cairndex library yet. Nothing has been
   * created: the shell is holding the path, and the UI must ask for a name and
   * call `confirmHostPickedLibrary` with `token`. Every other field is empty.
   */
  needsConfirmation: boolean
  /** Redeems the held folder in `confirmHostPickedLibrary`. Opaque — not a path. */
  token: string | null
  /** The picked folder's basename, which prefills the name field. */
  folderName: string | null
  /**
   * With `needsConfirmation`, whether the parked folder is already a library
   * (confirm registers it — no name needed) or a plain folder (confirm creates
   * one from the typed name). Lets the dialog show Add versus Create.
   */
  isLibrary: boolean
  /**
   * True when the caller's *current* server already has this library, so no
   * local server was started. Opening it locally would register a second server
   * against the same folder, which the ownership lease then refuses — the user
   * ends up told their library is "open on <their own machine>".
   */
  alreadyAvailable: boolean
  /** Empty when `alreadyAvailable`: ids are per-registry, so ours would be wrong. */
  libraryId: string
  libraryUuid: string
  displayName: string | null
}

/** One saved connection (plan 3 §7.1). */
export interface StoredConnection {
  id: string
  kind: 'remote' | 'local'
  label: string
  /**
   * Null for the managed local connection: the sidecar's port is ephemeral and
   * valid only for the current process, so it is resolved at activation rather
   * than persisted.
   */
  serverUrl: string | null
}

export interface StoredConnections {
  connections: StoredConnection[]
  activeConnectionId: string | null
}

// One resolved `cairndex://` deep link (plan 3 §7). `libraryId` is optional; when
// absent the target opens in whatever library is already active.
export interface DeepLinkTarget {
  kind: 'bundle' | 'collection'
  id: string
  libraryId?: string | null
}

export type HostOs = 'macos' | 'windows' | 'linux' | 'unknown'

// Supplies host-specific wording without leaking OS tests into the SPA
export interface HostLabels {
  revealFile: string
  openFile: string
  locateLibrary: string
  deviceName: string
}

// Extends public capabilities with shell bootstrap and transport services
interface PlatformRuntime {
  platform: HostPlatform
  os: HostOs
  revealWindow(): Promise<void>
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
  assetUrl(value: string): string
  /**
   * Binds transport and media relay to one server.
   *
   * `localToken` is the sidecar's server-wide bearer; the shell derives the
   * relay's scope mode by matching the running sidecar, so no scope flag
   * crosses this boundary.
   */
  configureServer(serverUrl: string, options?: { localToken?: string | null }): Promise<void>
  startLocalServer(): Promise<LocalServerInfo>
  localServerStatus(): Promise<LocalServerInfo | null>
  openLibraryFolder(knownLibraryUuids: string[], stage: boolean): Promise<OpenedLibrary | null>
  confirmPickedLibrary(token: string, name: string): Promise<OpenedLibrary>
  loadConnections(): Promise<StoredConnections | null>
  saveConnections(value: StoredConnections): Promise<void>
  hasDeviceToken(): boolean
  hasDeviceAccess(libraryId: string): boolean
  saveDeviceToken(token: string, libraryIds: string[]): Promise<void>
  clearDeviceToken(): Promise<void>
  loadServerUrl(): Promise<string | null>
  saveServerUrl(serverUrl: string): Promise<void>
  normalizeServerUrl(value: string): Promise<string>
  listenMenu(handler: (action: DesktopMenuAction) => void): Promise<() => void>
  setLibraryAvailable(enabled: boolean): Promise<void>
  setServerAvailable(enabled: boolean): Promise<void>
  setViewerMenuAvailable(viewer: boolean, video: boolean): Promise<void>
  toggleWindowFullscreen(): Promise<boolean>
  isWindowFullscreen(): Promise<boolean>
  listenFullscreen(handler: (fullscreen: boolean) => void): Promise<() => void>
  listenDeepLink(handler: (target: DeepLinkTarget) => void): Promise<() => void>
  takePendingDeepLink(): Promise<DeepLinkTarget | null>
  ensureNotificationPermission(): Promise<boolean>
  notify(title: string, body: string): Promise<void>
  setBadgeCount(count: number | null): Promise<void>
  listenLifecycle(): Promise<() => void>
  reverseMapPaths(libraryId: string, paths: string[]): Promise<ReverseMapResult>
  listenFileDrop(handler: (paths: string[]) => void): Promise<() => void>
  listenImportProgress(handler: (progress: ImportProgressEvent) => void): Promise<() => void>
  /**
   * Stream one *dropped* file into a library (plan 4 W5).
   *
   * Only the shell can do this: a browser cannot read an absolute path, and the
   * shell refuses any path it did not itself see in a drop. Undefined in the
   * browser, where dropped files arrive as real `File` objects the web layer
   * uploads directly.
   */
  importDroppedFile?(request: {
    libraryId: string
    path: string
    destDir: string
    onConflict?: string
  }): Promise<HostImportOutcome>
  // True while a shell-initiated drag-out is still on the pasteboard, so the drop
  // listener ignores the app's own files dragged back onto the window (P1-4).
  isDragOutActive(): boolean
  // Clears the drag-out guard (a drop landing on us means the session ended, P0-4).
  releaseDragOut(): void
}

const LABELS: Record<HostOs, HostLabels> = {
  macos: {
    revealFile: 'Reveal in Finder',
    openFile: 'Open in Default App',
    locateLibrary: 'Locate on This Mac',
    deviceName: 'Cairndex Desktop for Mac',
  },
  windows: {
    revealFile: 'Show in File Explorer',
    openFile: 'Open in Default App',
    locateLibrary: 'Locate on This PC',
    deviceName: 'Cairndex Desktop for Windows',
  },
  linux: {
    revealFile: 'Show in File Manager',
    openFile: 'Open in Default App',
    locateLibrary: 'Locate on This Computer',
    deviceName: 'Cairndex Desktop for Linux',
  },
  unknown: {
    revealFile: 'Show in File Manager',
    openFile: 'Open in Default App',
    locateLibrary: 'Locate on This Computer',
    deviceName: 'Cairndex Desktop',
  },
}

const webRuntime: PlatformRuntime = {
  platform: webPlatform,
  os: 'unknown',
  revealWindow: async () => undefined,
  fetch: (input, init) => globalThis.fetch(input, init),
  assetUrl: (value) => value,
  configureServer: async () => undefined,
  // The browser has no sidecar and no connections record; a local library is a
  // desktop-only concept.
  startLocalServer: async () => {
    throw new Error('The local server is only available in the desktop app.')
  },
  localServerStatus: async () => null,
  // The browser cannot produce a server absolute path from a file input, so
  // there is nothing to pick and nothing to confirm; typed paths cover the
  // browser entirely.
  openLibraryFolder: async () => null,
  confirmPickedLibrary: async () => {
    throw new Error('Choosing a folder is only available in the desktop app.')
  },
  loadConnections: async () => null,
  saveConnections: async () => undefined,
  hasDeviceToken: () => false,
  hasDeviceAccess: () => false,
  saveDeviceToken: async () => undefined,
  clearDeviceToken: async () => undefined,
  loadServerUrl: async () => null,
  saveServerUrl: async () => undefined,
  normalizeServerUrl: async (value) => value,
  listenMenu: async () => () => undefined,
  setLibraryAvailable: async () => undefined,
  setServerAvailable: async () => undefined,
  setViewerMenuAvailable: async () => undefined,
  // The browser has no native window fullscreen; the viewer keeps using the
  // HTML Fullscreen API there (see usePlayer.toggleFullscreen).
  toggleWindowFullscreen: async () => false,
  isWindowFullscreen: async () => false,
  listenFullscreen: async () => () => undefined,
  listenDeepLink: async () => () => undefined,
  takePendingDeepLink: async () => null,
  // The browser build deliberately does not ask for the Notification API: a web
  // page prompting for notifications is exactly the pattern users distrust, and
  // the tab is visible anyway when the owner triggers a job.
  ensureNotificationPermission: async () => false,
  notify: async () => undefined,
  setBadgeCount: async () => undefined,
  listenLifecycle: async () => () => undefined,
  reverseMapPaths: async () => ({ inside: [], outside: [], directories: 0 }),
  listenFileDrop: async () => () => undefined,
  listenImportProgress: async () => () => undefined,
  isDragOutActive: () => false,
  releaseDragOut: () => undefined,
}

let runtime = webRuntime
let initializePromise: Promise<HostPlatform> | null = null

// Detects the native shell without pulling Tauri packages into the browser entry
export function isDesktopHost(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

// Loads the Tauri-backed implementation once before the shared SPA mounts
export function initializeHostPlatform(): Promise<HostPlatform> {
  if (!isDesktopHost()) return Promise.resolve(webPlatform)
  initializePromise ??= import('./desktop').then(async ({ createDesktopRuntime }) => {
    runtime = await createDesktopRuntime()
    return runtime.platform
  })
  return initializePromise
}

// Returns the initialized host capability surface
export function getHostPlatform(): HostPlatform {
  return runtime.platform
}

// Reveals the native window after the renderer has mounted its dark document
export const revealHostWindow = (): Promise<void> => runtime.revealWindow()

// Returns OS-specific copy without changing the OS-neutral capability interface
export function getHostLabels(): HostLabels {
  return hostLabelsFor(runtime.os)
}

// Resolves the label table for one detected desktop OS
export function hostLabelsFor(os: HostOs): HostLabels {
  return LABELS[os]
}

// Web-owned copy for the shell's structured error codes, so user-facing
// wording stays in this layer (§2.1) and codes can gain distinct treatment
const HOST_ERROR_MESSAGES: Record<string, string> = {
  host_action_failed: 'The operating system could not open this file.',
  drag_action_failed: 'The file drag could not be started.',
  no_draggable_files: 'None of these files are available to drag.',
  invalid_library_id: 'The server library identity is missing.',
  invalid_library_root: 'The mapped library folder is unavailable.',
  invalid_manifest: 'The selected folder is not a Cairndex library.',
  invalid_relative_path: 'The file path is not a safe library-relative path.',
  library_mismatch: 'This folder belongs to a different Cairndex library.',
  library_unmapped: 'This library is not located on this computer.',
  mapping_store_unavailable: 'Library mappings are unavailable.',
  path_not_found: 'The file does not exist at its mapped location.',
  path_outside_library: 'The file path escapes the mapped library folder.',
  volume_not_mounted: 'Volume not mounted. Reconnect it and try again.',
}

// Extracts a safe user-facing message from a structured native command error
export function hostOperationErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const { code, message } = error as { code?: unknown; message?: unknown }
    if (typeof code === 'string' && code in HOST_ERROR_MESSAGES)
      return HOST_ERROR_MESSAGES[code] as string
    if (typeof message === 'string' && message) return message
  }
  if (typeof error === 'string' && error) return error
  return 'The desktop action could not be completed.'
}

// Routes every programmatic server request through the active platform transport
export function hostFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return runtime.fetch(input, init)
}

// Routes media-element and beacon URLs through the desktop bearer relay
export function resolveHostAssetUrl(value: string): string {
  return runtime.assetUrl(value)
}

// Binds desktop auth and media transport to one normalized Cairndex server
export function configureHostServer(
  serverUrl: string,
  options?: { localToken?: string | null },
): Promise<void> {
  return runtime.configureServer(serverUrl, options)
}

// Starts the bundled local server, or returns the one already running
export const startHostLocalServer = (): Promise<LocalServerInfo> => runtime.startLocalServer()

// Reports the running local server without starting one
export const hostLocalServerStatus = (): Promise<LocalServerInfo | null> =>
  runtime.localServerStatus()

// Picks a library folder and opens it through the local server, returning ids only.
// `knownLibraryUuids` are the portable ids the caller's current server already
// serves, so a folder it already has is reported rather than opened twice.
export const openHostLibraryFolder = (
  knownLibraryUuids: string[],
  // Stage an existing library (park it for a confirm) rather than open it
  // immediately. The Manage dialog stages; the first-run/menu open-folder flow
  // does not. See `open_library_folder` in the shell.
  stage = false,
): Promise<OpenedLibrary | null> => runtime.openLibraryFolder(knownLibraryUuids, stage)

// Creates a library at the folder a previous pick is holding, under the name the
// user confirmed. `token` is the opaque handle from that pick — the path itself
// stays in the shell.
export const confirmHostPickedLibrary = (token: string, name: string): Promise<OpenedLibrary> =>
  runtime.confirmPickedLibrary(token, name)

export const loadHostConnections = (): Promise<StoredConnections | null> =>
  runtime.loadConnections()
export const saveHostConnections = (value: StoredConnections): Promise<void> =>
  runtime.saveConnections(value)

// Reports whether this shell already retains a device bearer token
export function hasHostDeviceToken(): boolean {
  return runtime.hasDeviceToken()
}

// Reports whether the retained bearer explicitly grants one library
export function hasHostDeviceAccess(libraryId: string): boolean {
  return runtime.hasDeviceAccess(libraryId)
}

// Persists a one-time pairing token without exposing it to web storage
export function saveHostDeviceToken(token: string, libraryIds: string[]): Promise<void> {
  return runtime.saveDeviceToken(token, libraryIds)
}

// Removes the locally retained device token
export function clearHostDeviceToken(): Promise<void> {
  return runtime.clearDeviceToken()
}

export const loadHostServerUrl = (): Promise<string | null> => runtime.loadServerUrl()
export const saveHostServerUrl = (serverUrl: string): Promise<void> =>
  runtime.saveServerUrl(serverUrl)
export const normalizeHostServerUrl = (value: string): Promise<string> =>
  runtime.normalizeServerUrl(value)
export const listenHostMenu = (handler: (action: DesktopMenuAction) => void): Promise<() => void> =>
  runtime.listenMenu(handler)
export const setHostLibraryAvailable = (enabled: boolean): Promise<void> =>
  runtime.setLibraryAvailable(enabled)
export const setHostServerAvailable = (enabled: boolean): Promise<void> =>
  runtime.setServerAvailable(enabled)

// Enables Playback items while a viewer is open. `video` is tracked separately
// because an image bundle has no player, so the player-only items would be live
// but dead there.
export const setHostViewerMenuAvailable = (viewer: boolean, video: boolean): Promise<void> =>
  runtime.setViewerMenuAvailable(viewer, video)

// Toggles real window fullscreen in the shell atomically, returning the new state.
// A no-op returning false in the browser.
export const toggleHostWindowFullscreen = (): Promise<boolean> => runtime.toggleWindowFullscreen()

export const isHostWindowFullscreen = (): Promise<boolean> => runtime.isWindowFullscreen()

// Subscribes to cairndex:// deep links delivered while the app is running
export const listenHostDeepLink = (
  handler: (target: DeepLinkTarget) => void,
): Promise<() => void> => runtime.listenDeepLink(handler)

// Drains a deep link that arrived before the SPA could listen (cold start)
export const takeHostPendingDeepLink = (): Promise<DeepLinkTarget | null> =>
  runtime.takePendingDeepLink()

// Asks for notification permission once, returning whether it is granted
export const ensureHostNotificationPermission = (): Promise<boolean> =>
  runtime.ensureNotificationPermission()

// Posts a user notification through the OS notification centre
export const notifyHost = (title: string, body: string): Promise<void> =>
  runtime.notify(title, body)

// Sets or clears the dock/taskbar badge (null clears it)
export const setHostBadgeCount = (count: number | null): Promise<void> =>
  runtime.setBadgeCount(count)

// Observes native fullscreen changes made outside the viewer (the View menu)
export const listenHostFullscreen = (handler: (fullscreen: boolean) => void): Promise<() => void> =>
  runtime.listenFullscreen(handler)
export const listenHostLifecycle = (): Promise<() => void> => runtime.listenLifecycle()

// Per-file upload progress for the desktop drag-in copy (plan 4 W5).
export const listenHostImportProgress = (
  handler: (progress: ImportProgressEvent) => void,
): Promise<() => void> => runtime.listenImportProgress(handler)

// Reverse-maps Finder-dropped absolute paths against one library's local mapping
export const reverseMapHostPaths = (
  libraryId: string,
  paths: string[],
): Promise<ReverseMapResult> => runtime.reverseMapPaths(libraryId, paths)

// Subscribes to OS file drops onto the shell window (no-op in the browser)
export const listenHostFileDrop = (handler: (paths: string[]) => void): Promise<() => void> =>
  runtime.listenFileDrop(handler)

/** What the shell reports after copying one dropped file into a library. */
export interface HostImportOutcome {
  path: string
  operationId: string
  sizeBytes: number
  skipped: boolean
}

/** Whether this host can copy dropped files in at all (desktop only). */
export const canImportDroppedFiles = (): boolean => runtime.importDroppedFile !== undefined

/** Copy one dropped file into a library through the shell. */
export const importHostDroppedFile = (request: {
  libraryId: string
  path: string
  destDir: string
  onConflict?: string
}): Promise<HostImportOutcome> => {
  if (!runtime.importDroppedFile) throw new Error('This host cannot copy files in.')
  return runtime.importDroppedFile(request)
}

// Reports whether a shell-initiated drag-out is still in flight (always false on web)
export const isHostDragOutActive = (): boolean => runtime.isDragOutActive()

// Clears the drag-out guard once a drop lands on us (the native session ended)
export const releaseHostDragOut = (): void => runtime.releaseDragOut()

// Test-only reset for singleton isolation across desktop/browser seam cases
export function resetHostPlatformForTests(): void {
  runtime = webRuntime
  initializePromise = null
}

export type { PlatformRuntime }

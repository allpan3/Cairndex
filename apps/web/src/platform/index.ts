import type { DesktopMenuAction } from '../desktop/types'
import { webPlatform } from './web'

// Describes one library-relative file exported through a host operation
export interface DragOutItem {
  libraryId: string
  relativePath: string
}

// Outcome of reverse-mapping Finder-dropped absolute paths against one library:
// `inside` holds library-relative paths for files under the mapped root (offered
// to the fast-add flow); `outsideCount` is how many fell outside it. Absolute
// paths never cross back to the web layer (plan 3 §6).
export interface ReverseMapResult {
  inside: string[]
  outsideCount: number
}

// Defines the complete web-versus-native host boundary from plan 3 section 4
export interface HostPlatform {
  kind: 'web' | 'desktop'
  canRevealInFinder: boolean
  canOpenWithDefaultApp: boolean
  canDragOutFiles: boolean
  revealFile(libraryId: string, relativePath: string): Promise<void>
  openFile(libraryId: string, relativePath: string): Promise<void>
  startFileDrag(items: DragOutItem[]): Promise<void>
  getLibraryMapping(libraryId: string): Promise<string | null>
  locateLibrary(libraryId: string, libraryUuid: string): Promise<string | null>
  clearLibraryMapping(libraryId: string): Promise<void>
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
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
  assetUrl(value: string): string
  configureServer(serverUrl: string): Promise<void>
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
  listenLifecycle(): Promise<() => void>
  reverseMapPaths(libraryId: string, paths: string[]): Promise<ReverseMapResult>
  listenFileDrop(handler: (paths: string[]) => void): Promise<() => void>
  // True while a shell-initiated drag-out is still on the pasteboard, so the drop
  // listener ignores the app's own files dragged back onto the window (P1-4).
  isDragOutActive(): boolean
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
  fetch: (input, init) => globalThis.fetch(input, init),
  assetUrl: (value) => value,
  configureServer: async () => undefined,
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
  listenLifecycle: async () => () => undefined,
  reverseMapPaths: async () => ({ inside: [], outsideCount: 0 }),
  listenFileDrop: async () => () => undefined,
  isDragOutActive: () => false,
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
export function configureHostServer(serverUrl: string): Promise<void> {
  return runtime.configureServer(serverUrl)
}

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
export const listenHostLifecycle = (): Promise<() => void> => runtime.listenLifecycle()

// Reverse-maps Finder-dropped absolute paths against one library's local mapping
export const reverseMapHostPaths = (
  libraryId: string,
  paths: string[],
): Promise<ReverseMapResult> => runtime.reverseMapPaths(libraryId, paths)

// Subscribes to OS file drops onto the shell window (no-op in the browser)
export const listenHostFileDrop = (handler: (paths: string[]) => void): Promise<() => void> =>
  runtime.listenFileDrop(handler)

// Reports whether a shell-initiated drag-out is still in flight (always false on web)
export const isHostDragOutActive = (): boolean => runtime.isDragOutActive()

// Test-only reset for singleton isolation across desktop/browser seam cases
export function resetHostPlatformForTests(): void {
  runtime = webRuntime
  initializePromise = null
}

export type { PlatformRuntime }

import type { DesktopMenuAction } from '../desktop/types'
import { webPlatform } from './web'

// Describes one library-relative file exported through a host operation
export interface DragOutItem {
  libraryId: string
  relativePath: string
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

// Extracts a safe user-facing message from a structured native command error
export function hostOperationErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message
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

// Test-only reset for singleton isolation across desktop/browser seam cases
export function resetHostPlatformForTests(): void {
  runtime = webRuntime
  initializePromise = null
}

export type { PlatformRuntime }

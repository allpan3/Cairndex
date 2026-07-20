import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { load } from '@tauri-apps/plugin-store'

import { runDesktopExitTasks } from '../desktop/exitTasks'
import type { DesktopMenuAction } from '../desktop/types'
import { createDragGuard } from './dragGuard'
import type { HostOs, HostPlatform, PlatformRuntime, ReverseMapResult } from './index'

const STORE_PATH = 'cairndex-settings.json'
const SERVER_URL_KEY = 'serverUrl'
const DEVICE_AUTH_KEY = 'deviceAuth'

// Couples a retained device token to the server that issued it
interface DeviceAuthRecord {
  serverUrl: string
  token: string
  libraryIds: string[]
}

let configuredServerUrl: string | null = null
let deviceToken: string | null = null
let deviceLibraryIds = new Set<string>()
let mediaProxyBaseUrl: string | null = null

// Maps the browser-reported desktop OS onto the shared label vocabulary
function detectHostOs(): HostOs {
  const source = `${navigator.platform} ${navigator.userAgent}`.toLowerCase()
  if (source.includes('mac')) return 'macos'
  if (source.includes('win')) return 'windows'
  if (source.includes('linux')) return 'linux'
  return 'unknown'
}

// Opens the shell-owned settings store without enabling web/localStorage fallback
async function settingsStore() {
  return load(STORE_PATH, { autoSave: false, defaults: {} })
}

// Loads a complete token grant only when it belongs to the configured server
async function loadDeviceAuth(serverUrl: string): Promise<DeviceAuthRecord | null> {
  const store = await settingsStore()
  const record = await store.get<DeviceAuthRecord>(DEVICE_AUTH_KEY)
  if (
    !record ||
    record.serverUrl !== serverUrl ||
    typeof record.token !== 'string' ||
    !record.token ||
    !Array.isArray(record.libraryIds) ||
    record.libraryIds.length === 0 ||
    record.libraryIds.some((libraryId) => typeof libraryId !== 'string' || !libraryId)
  )
    return null
  return { ...record, libraryIds: [...new Set(record.libraryIds)] }
}

// Refreshes the native streaming relay after a server or token change
async function configureMediaProxy(): Promise<void> {
  if (!configuredServerUrl) {
    mediaProxyBaseUrl = null
    return
  }
  mediaProxyBaseUrl = await invoke<string>('configure_media_proxy', {
    serverUrl: configuredServerUrl,
    token: deviceToken,
    libraryIds: [...deviceLibraryIds],
  })
}

// Returns whether a URL belongs to the configured Cairndex server base path
function isServerUrl(value: string): boolean {
  if (!configuredServerUrl) return false
  try {
    const server = new URL(configuredServerUrl)
    const target = new URL(value, configuredServerUrl)
    const basePath = server.pathname.replace(/\/+$/, '')
    return (
      target.origin === server.origin &&
      (target.pathname === basePath || target.pathname.startsWith(`${basePath}/`))
    )
  } catch {
    return false
  }
}

// Extracts a library scope only from the configured server's versioned API
function serverLibraryId(value: string): string | null {
  if (!configuredServerUrl || !isServerUrl(value)) return null
  const server = new URL(configuredServerUrl)
  const target = new URL(value, configuredServerUrl)
  const basePath = server.pathname.replace(/\/+$/, '')
  const relativePath = target.pathname.slice(basePath.length)
  const match = /^\/api\/v1\/libraries\/([^/]+)(?:\/|$)/.exec(relativePath)
  const encodedLibraryId = match?.[1]
  if (!encodedLibraryId) return null
  try {
    return decodeURIComponent(encodedLibraryId)
  } catch {
    return null
  }
}

// Attaches the retained bearer only to explicitly approved library requests
async function desktopFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const value = input instanceof Request ? input.url : String(input)
  const libraryId = serverLibraryId(value)
  if (!deviceToken || !libraryId || !deviceLibraryIds.has(libraryId))
    return globalThis.fetch(input, init)
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  new Headers(init?.headers).forEach((headerValue, name) => headers.set(name, headerValue))
  headers.set('Authorization', `Bearer ${deviceToken}`)
  return globalThis.fetch(input, { ...init, headers })
}

// Converts a server media URL to the fixed-target loopback relay
function desktopAssetUrl(value: string): string {
  const libraryId = serverLibraryId(value)
  if (!configuredServerUrl || !mediaProxyBaseUrl || !libraryId || !deviceLibraryIds.has(libraryId))
    return value
  const server = new URL(configuredServerUrl)
  const target = new URL(value, configuredServerUrl)
  const basePath = server.pathname.replace(/\/+$/, '')
  const suffix = target.pathname.slice(basePath.length) || '/'
  return `${mediaProxyBaseUrl}${suffix}${target.search}${target.hash}`
}

// The stateless part of the plan-3 host surface (D3 handoff + D4 drag-out enabled).
// `startFileDrag` is added per-runtime below so the self-drop guard state lives on
// the runtime object the tests replace (P2-9), not in module scope.
const desktopPlatformBase: Omit<HostPlatform, 'startFileDrag'> = {
  kind: 'desktop',
  canRevealInFinder: true,
  canOpenWithDefaultApp: true,
  canDragOutFiles: true,
  revealFile: (libraryId: string, relativePath: string) =>
    invoke('reveal_file', { libraryId, relativePath }),
  openFile: (libraryId: string, relativePath: string) =>
    invoke('open_file', { libraryId, relativePath }),
  getLibraryMapping: (libraryId: string) =>
    invoke<string | null>('get_library_mapping', { libraryId }),
  locateLibrary: (libraryId: string, libraryUuid: string) =>
    invoke<string | null>('locate_library_mapping', { libraryId, libraryUuid }),
  clearLibraryMapping: (libraryId: string) => invoke('clear_library_mapping', { libraryId }),
}

// Builds the lazily loaded desktop runtime used behind the plain-web seam
export async function createDesktopRuntime(): Promise<PlatformRuntime> {
  // Per-runtime so resetHostPlatformForTests (which swaps the runtime) drops the
  // guard, and each created runtime starts with fresh drag state (P0-4/P2-9).
  const dragGuard = createDragGuard({ invoke, listen })
  return {
    platform: { ...desktopPlatformBase, startFileDrag: dragGuard.startFileDrag },
    os: detectHostOs(),
    fetch: desktopFetch,
    assetUrl: desktopAssetUrl,
    configureServer: async (serverUrl) => {
      configuredServerUrl = serverUrl
      const auth = await loadDeviceAuth(serverUrl)
      deviceToken = auth?.token ?? null
      deviceLibraryIds = new Set(auth?.libraryIds ?? [])
      await configureMediaProxy()
    },
    hasDeviceToken: () => deviceToken !== null,
    hasDeviceAccess: (libraryId) => deviceToken !== null && deviceLibraryIds.has(libraryId),
    saveDeviceToken: async (token, libraryIds) => {
      if (!configuredServerUrl) throw new Error('No Cairndex server is configured.')
      const scopes = [...new Set(libraryIds.filter(Boolean))]
      if (scopes.length === 0) throw new Error('Device pairing did not approve any libraries.')
      const store = await settingsStore()
      await store.set(DEVICE_AUTH_KEY, {
        serverUrl: configuredServerUrl,
        token,
        libraryIds: scopes,
      })
      await store.save()
      deviceToken = token
      deviceLibraryIds = new Set(scopes)
      await configureMediaProxy()
    },
    clearDeviceToken: async () => {
      const store = await settingsStore()
      await store.delete(DEVICE_AUTH_KEY)
      await store.save()
      deviceToken = null
      deviceLibraryIds = new Set()
      await configureMediaProxy()
    },
    loadServerUrl: async () => {
      const store = await settingsStore()
      return (await store.get<string>(SERVER_URL_KEY)) ?? null
    },
    saveServerUrl: async (serverUrl) => {
      const store = await settingsStore()
      const auth = await store.get<DeviceAuthRecord>(DEVICE_AUTH_KEY)
      await store.set(SERVER_URL_KEY, serverUrl)
      if (auth && auth.serverUrl !== serverUrl) await store.delete(DEVICE_AUTH_KEY)
      await store.save()
    },
    normalizeServerUrl: (value) => invoke<string>('normalize_server_url_command', { value }),
    listenMenu: (handler) =>
      listen<DesktopMenuAction>('cairndex://menu', (event) => handler(event.payload)),
    setLibraryAvailable: (enabled) => invoke('set_library_menu_enabled', { enabled }),
    setServerAvailable: (enabled) => invoke('set_server_menu_enabled', { enabled }),
    setPlaybackAvailable: (enabled) => invoke('set_playback_menu_enabled', { enabled }),
    // Native window fullscreen, not the HTML Fullscreen API: WKWebView requires
    // user activation for the latter, which a menu item does not carry (D1).
    setWindowFullscreen: (fullscreen) => invoke('set_window_fullscreen', { fullscreen }),
    isWindowFullscreen: () => getCurrentWindow().isFullscreen(),
    listenFullscreen: (handler) =>
      listen<boolean>('cairndex://fullscreen', (event) => handler(event.payload)),
    listenLifecycle: async () => {
      const appWindow = getCurrentWindow()
      const stopClose = await appWindow.onCloseRequested(async (event) => {
        event.preventDefault()
        await invoke('request_exit')
      })
      try {
        const stopExit = await listen('cairndex://exit-requested', async () => {
          await runDesktopExitTasks()
          window.dispatchEvent(new Event('pagehide'))
          await invoke('finish_exit')
        })
        return () => {
          stopClose()
          stopExit()
        }
      } catch (error) {
        stopClose()
        throw error
      }
    },
    reverseMapPaths: (libraryId, paths) =>
      invoke<ReverseMapResult>('reverse_map_paths', { libraryId, paths }),
    listenFileDrop: (handler) =>
      // Tauri delivers OS file drops as a native webview event (dragDropEnabled),
      // carrying the real absolute paths; internal DOM drag-and-drop is untouched.
      getCurrentWebview().onDragDropEvent((event) => {
        if (event.payload.type === 'drop') handler(event.payload.paths)
      }),
    isDragOutActive: dragGuard.isActive,
    releaseDragOut: dragGuard.release,
  }
}

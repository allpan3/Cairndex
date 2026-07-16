import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { load } from '@tauri-apps/plugin-store'

import { runDesktopExitTasks } from '../desktop/exitTasks'
import type { DesktopMenuAction } from '../desktop/types'
import type { DragOutItem, HostOs, HostPlatform, PlatformRuntime } from './index'

const STORE_PATH = 'cairndex-settings.json'
const SERVER_URL_KEY = 'serverUrl'
const DEVICE_AUTH_KEY = 'deviceAuth'

// Couples a retained device token to the server that issued it
interface DeviceAuthRecord {
  serverUrl: string
  token: string
}

let configuredServerUrl: string | null = null
let deviceToken: string | null = null
let mediaProxyBaseUrl: string | null = null

// Maps the browser-reported desktop OS onto the shared label/keymap vocabulary
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

// Loads a token only when it belongs to the currently configured server
async function loadDeviceToken(serverUrl: string): Promise<string | null> {
  const store = await settingsStore()
  const record = await store.get<DeviceAuthRecord>(DEVICE_AUTH_KEY)
  if (
    !record ||
    record.serverUrl !== serverUrl ||
    typeof record.token !== 'string' ||
    !record.token
  )
    return null
  return record.token
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

// Attaches the retained bearer only to the configured Cairndex server
async function desktopFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const value = input instanceof Request ? input.url : String(input)
  if (!deviceToken || !isServerUrl(value)) return globalThis.fetch(input, init)
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  new Headers(init?.headers).forEach((headerValue, name) => headers.set(name, headerValue))
  headers.set('Authorization', `Bearer ${deviceToken}`)
  return globalThis.fetch(input, { ...init, headers })
}

// Converts a server media URL to the fixed-target loopback relay
function desktopAssetUrl(value: string): string {
  if (!configuredServerUrl || !mediaProxyBaseUrl || !isServerUrl(value)) return value
  const server = new URL(configuredServerUrl)
  const target = new URL(value, configuredServerUrl)
  const basePath = server.pathname.replace(/\/+$/, '')
  const suffix = target.pathname.slice(basePath.length) || '/'
  return `${mediaProxyBaseUrl}${suffix}${target.search}${target.hash}`
}

// Implements the plan-3 host surface while D3/D4 capabilities remain disabled
const desktopPlatform: HostPlatform = {
  kind: 'desktop',
  canRevealInFinder: false,
  canOpenWithDefaultApp: false,
  canDragOutFiles: false,
  revealFile: (libraryId: string, relativePath: string) =>
    invoke('reveal_file', { libraryId, relativePath }),
  openFile: (libraryId: string, relativePath: string) =>
    invoke('open_file', { libraryId, relativePath }),
  startFileDrag: (items: DragOutItem[]) => invoke('start_file_drag', { items }),
  getLibraryMapping: (libraryId: string) =>
    invoke<string | null>('get_library_mapping', { libraryId }),
  setLibraryMapping: (libraryId: string, localRoot: string) =>
    invoke('set_library_mapping', { libraryId, localRoot }),
}

// Builds the lazily loaded desktop runtime used behind the plain-web seam
export async function createDesktopRuntime(): Promise<PlatformRuntime> {
  return {
    platform: desktopPlatform,
    os: detectHostOs(),
    fetch: desktopFetch,
    assetUrl: desktopAssetUrl,
    configureServer: async (serverUrl) => {
      configuredServerUrl = serverUrl
      deviceToken = await loadDeviceToken(serverUrl)
      await configureMediaProxy()
    },
    hasDeviceToken: () => deviceToken !== null,
    saveDeviceToken: async (token) => {
      if (!configuredServerUrl) throw new Error('No Cairndex server is configured.')
      const store = await settingsStore()
      await store.set(DEVICE_AUTH_KEY, { serverUrl: configuredServerUrl, token })
      await store.save()
      deviceToken = token
      await configureMediaProxy()
    },
    clearDeviceToken: async () => {
      const store = await settingsStore()
      await store.delete(DEVICE_AUTH_KEY)
      await store.save()
      deviceToken = null
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
  }
}

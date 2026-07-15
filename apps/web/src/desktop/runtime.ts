import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { load } from '@tauri-apps/plugin-store'

export type DesktopMenuAction =
  | 'settings'
  | 'pair-device'
  | 'new-bundle'
  | 'show-bundles'
  | 'show-files'
  | 'zoom-in'
  | 'zoom-out'
  | 'toggle-sidebar'
  | 'toggle-inspector'
  | 'fullscreen'

const STORE_PATH = 'cairndex-settings.json'
const SERVER_URL_KEY = 'serverUrl'

// Reports whether the SPA is running inside the Tauri desktop host
export function isDesktopHost(): boolean {
  return isTauri()
}

// Loads the configured Cairndex server URL from the desktop-owned store
export async function loadDesktopServerUrl(): Promise<string | null> {
  const store = await load(STORE_PATH, { autoSave: false, defaults: {} })
  return (await store.get<string>(SERVER_URL_KEY)) ?? null
}

// Persists the verified Cairndex server URL for subsequent launches
export async function saveDesktopServerUrl(serverUrl: string): Promise<void> {
  const store = await load(STORE_PATH, { autoSave: false, defaults: {} })
  await store.set(SERVER_URL_KEY, serverUrl)
  await store.save()
}

// Delegates URL validation to the Tauri command so Rust owns the stored form
export function normalizeDesktopServerUrl(value: string): Promise<string> {
  return invoke<string>('normalize_server_url_command', { value })
}

// Subscribes the SPA to semantic actions from the native application menu
export function listenDesktopMenu(
  handler: (action: DesktopMenuAction) => void,
): Promise<UnlistenFn> {
  return listen<DesktopMenuAction>('cairndex://menu', (event) => handler(event.payload))
}

// Gives pagehide reporters time to queue beacons before the native webview is destroyed
export function listenDesktopClose(): Promise<UnlistenFn> {
  const appWindow = getCurrentWindow()
  return appWindow.onCloseRequested(async (event) => {
    event.preventDefault()
    window.dispatchEvent(new Event('pagehide'))
    await new Promise((resolve) => window.setTimeout(resolve, 50))
    await appWindow.destroy()
  })
}

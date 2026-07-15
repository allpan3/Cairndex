import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { load } from '@tauri-apps/plugin-store'

import type { DesktopMenuAction } from './types'

const STORE_PATH = 'cairndex-settings.json'
const SERVER_URL_KEY = 'serverUrl'
const SHUTDOWN_GRACE_MS = 50

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

// Keeps workspace-only native commands disabled until a library is active
export function setDesktopLibraryAvailable(enabled: boolean): Promise<void> {
  return invoke('set_library_menu_enabled', { enabled })
}

// Gives close and application-quit paths the same pagehide persistence signal
export async function listenDesktopLifecycle(): Promise<UnlistenFn> {
  const appWindow = getCurrentWindow()
  const stopClose = await appWindow.onCloseRequested(async (event) => {
    event.preventDefault()
    window.dispatchEvent(new Event('pagehide'))
    await new Promise((resolve) => window.setTimeout(resolve, SHUTDOWN_GRACE_MS))
    await appWindow.destroy()
  })
  try {
    const stopExit = await listen('cairndex://exit-requested', async () => {
      window.dispatchEvent(new Event('pagehide'))
      await new Promise((resolve) => window.setTimeout(resolve, SHUTDOWN_GRACE_MS))
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
}

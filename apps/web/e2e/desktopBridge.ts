import type { Page } from '@playwright/test'

// The production entry and desktop adapter run unchanged; only native IPC is simulated in Chromium
export async function desktopBridge(
  page: Page,
  urls: string[],
  /** A `cairndex://` target the shell holds from a cold start, delivered once. */
  deepLink: { kind: 'bundle' | 'collection'; id: string; libraryId: string } | null = null,
) {
  await page.addInitScript(
    ({ urls, deepLink }) => {
      const settings = 'synthetic-native-settings'
      if (!localStorage.getItem(settings))
        localStorage.setItem(
          settings,
          JSON.stringify({
            connections: {
              connections: urls.slice(0, 2).map((url) => ({
                id: `remote:${url}`,
                kind: 'remote',
                label: new URL(url).host,
                serverUrl: url,
              })),
              activeConnectionId: `remote:${urls[0]}`,
            },
          }),
        )
      let callback = 0
      let pendingLink = deepLink
      // Event listeners by id, so a test can deliver what the shell would emit
      const callbacks = new Map<number, (event: unknown) => void>()
      const listeners = new Map<number, { event: string; handler: number }>()
      Object.assign(window, {
        __cairndexEmit: (event: string, payload: unknown) => {
          for (const listener of [...listeners.values()])
            if (listener.event === event)
              callbacks.get(listener.handler)?.({ event, id: 0, payload })
        },
        __TAURI_EVENT_PLUGIN_INTERNALS__: {
          unregisterListener: (_event: string, id: number) => listeners.delete(id),
        },
        __TAURI_INTERNALS__: {
          metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
          transformCallback: (fn: (event: unknown) => void) => {
            callbacks.set(++callback, fn)
            return callback
          },
          unregisterCallback: (id: number) => callbacks.delete(id),
          invoke: async (command: string, args: Record<string, unknown> = {}) => {
            const values = JSON.parse(localStorage.getItem(settings)!) as Record<string, unknown>
            if (command === 'plugin:store|load') return 1
            if (command === 'plugin:store|get')
              return [values[String(args.key)], String(args.key) in values]
            if (command === 'plugin:store|set') {
              values[String(args.key)] = args.value
              localStorage.setItem(settings, JSON.stringify(values))
            }
            if (command === 'plugin:store|delete') {
              delete values[String(args.key)]
              localStorage.setItem(settings, JSON.stringify(values))
            }
            if (command === 'normalize_server_url_command')
              return String(args.value).replace(/\/+$/, '')
            if (command === 'configure_media_proxy') return 'http://127.0.0.1:9/synthetic-relay'
            if (command === 'start_local_server')
              return { base_url: urls[2], token: 'synthetic-local-token' }
            if (command === 'plugin:event|listen') {
              listeners.set(++callback, {
                event: String(args.event),
                handler: Number(args.handler),
              })
              return callback
            }
            if (command === 'plugin:event|unlisten') listeners.delete(Number(args.eventId))
            if (command === 'is_window_fullscreen') return false
            if (command === 'take_pending_deep_link') {
              const target = pendingLink
              pendingLink = null
              return target
            }
            return null
          },
        },
      })
    },
    { urls, deepLink },
  )
}

/** Chooses a native menu item, as the shell does when the owner picks it. */
export async function desktopMenu(page: Page, action: string) {
  await page.evaluate(
    (action) =>
      (
        window as unknown as { __cairndexEmit: (event: string, payload: unknown) => void }
      ).__cairndexEmit('cairndex://menu', action),
    action,
  )
}

import { StrictMode, type ReactNode } from 'react'

export type RuntimeSurface = 'desktop' | 'web'

/** Applies development StrictMode replay without replaying the Tauri WKWebView root. */
export function RuntimeRoot({
  surface,
  children,
}: {
  surface: RuntimeSurface
  children: ReactNode
}) {
  // WebKit can strand immediate replacements for startup fetches aborted by replay
  if (surface === 'desktop') return <>{children}</>
  return <StrictMode>{children}</StrictMode>
}

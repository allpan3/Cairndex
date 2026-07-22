import { StrictMode, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import {
  initializeHostPlatform,
  isDesktopHost,
  primeHostWindowForPaint,
  revealHostWindow,
} from './platform'
import { QueryScope } from './QueryScope'

const root = createRoot(document.getElementById('root')!)

// Mounts the app tree. The query cache is scoped by `QueryScope`: the browser
// has one server and so one scope forever, while the desktop shell remounts it
// per connection (plan 3 §7.1) — which is why the provider lives below this
// point rather than here.
function renderApp(content: ReactNode): void {
  root.render(<StrictMode>{content}</StrictMode>)
}

// Replaces a blank webview with an actionable shell-load failure
function renderDesktopLoadError(error: unknown): ReactNode {
  console.error('Desktop shell failed to load', error)
  return (
    <QueryScope>
      <main className="app-loading" role="alert">
        The desktop shell could not load. Quit and reopen Cairndex.
      </main>
    </QueryScope>
  )
}

// Paints the mounted shell off-screen before moving its native window into place
async function revealDesktopWindowAfterPaint(): Promise<void> {
  try {
    const primed = await primeHostWindowForPaint()
    if (primed) {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      })
    }
    await revealHostWindow()
  } catch (error) {
    console.error('Desktop window could not be revealed', error)
    try {
      await revealHostWindow()
    } catch (fallbackError) {
      console.error('Desktop window reveal fallback failed', fallbackError)
    }
  }
}

// Loads the native bridge, mounts the shell, then acknowledges the dark document
async function renderDesktopApp(): Promise<void> {
  let content: ReactNode
  try {
    const [{ DesktopBootstrap }] = await Promise.all([
      import('./desktop/DesktopBootstrap'),
      initializeHostPlatform(),
    ])
    // DesktopBootstrap owns the scope key: it knows the active connection.
    content = (
      <DesktopBootstrap>
        <App />
      </DesktopBootstrap>
    )
  } catch (error) {
    content = renderDesktopLoadError(error)
  }
  flushSync(() => renderApp(content))
  void revealDesktopWindowAfterPaint()
}

if (isDesktopHost()) {
  void renderDesktopApp()
} else {
  renderApp(
    <QueryScope>
      <App />
    </QueryScope>,
  )
}

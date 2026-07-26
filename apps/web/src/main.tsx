import { StrictMode, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initializeHostPlatform, isDesktopHost, revealHostWindow } from './platform'
import { QueryScope } from './QueryScope'
import { markOverlayTitleBar } from './desktop/titleBar'

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

// Reveals the shell on the next renderer task after its dark document is mounted
function revealDesktopWindowAfterMount(): void {
  setTimeout(() => {
    void revealHostWindow().catch((error: unknown) => {
      console.error('Desktop window could not be revealed', error)
    })
  }, 0)
}

// Loads the native bridge, mounts the shell, then acknowledges the dark document
async function renderDesktopApp(): Promise<void> {
  markOverlayTitleBar(document, navigator.userAgent)
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
  revealDesktopWindowAfterMount()
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

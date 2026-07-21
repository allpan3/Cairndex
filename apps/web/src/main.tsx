import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { isDesktopHost } from './platform'
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
function renderDesktopLoadError(error: unknown): void {
  console.error('Desktop shell failed to load', error)
  renderApp(
    <QueryScope>
      <main className="app-loading" role="alert">
        The desktop shell could not load. Quit and reopen Cairndex.
      </main>
    </QueryScope>,
  )
}

if (isDesktopHost()) {
  void import('./desktop/DesktopBootstrap')
    .then(({ DesktopBootstrap }) => {
      // DesktopBootstrap owns the scope key: it knows the active connection.
      renderApp(
        <DesktopBootstrap>
          <App />
        </DesktopBootstrap>,
      )
    })
    .catch(renderDesktopLoadError)
} else {
  renderApp(
    <QueryScope>
      <App />
    </QueryScope>,
  )
}

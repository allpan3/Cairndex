import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: false },
  },
})

const root = createRoot(document.getElementById('root')!)

// Mounts one shared query/app tree with an optional desktop-only gate
function renderApp(content: ReactNode): void {
  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>{content}</QueryClientProvider>
    </StrictMode>,
  )
}

// Replaces a blank webview with an actionable shell-load failure
function renderDesktopLoadError(error: unknown): void {
  console.error('Desktop shell failed to load', error)
  renderApp(
    <main className="app-loading" role="alert">
      The desktop shell could not load. Quit and reopen Cairndex.
    </main>,
  )
}

if ('__TAURI_INTERNALS__' in window) {
  void import('./desktop/DesktopBootstrap')
    .then(({ DesktopBootstrap }) => {
      renderApp(
        <DesktopBootstrap>
          <App />
        </DesktopBootstrap>,
      )
    })
    .catch(renderDesktopLoadError)
} else {
  renderApp(<App />)
}

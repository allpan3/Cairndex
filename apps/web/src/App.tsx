import { useHealth } from './useHealth'

function BackendStatus() {
  const health = useHealth()

  switch (health.kind) {
    case 'loading':
      return (
        <p className="status status--pending" role="status">
          Checking backend…
        </p>
      )
    case 'error':
      return (
        <p className="status status--error" role="status">
          Backend unreachable — {health.message}
        </p>
      )
    case 'ok':
      return (
        <p className="status status--ok" role="status">
          Backend online · {health.data.app_name} ({health.data.environment})
        </p>
      )
  }
}

function App() {
  return (
    <main className="shell">
      <div className="shell__card">
        <h1 className="shell__title">Cairndex</h1>
        <p className="shell__tagline">Local-first media asset manager</p>
        <BackendStatus />
        <p className="shell__note">
          Phase 0 foundation. The bundle browser, inspector, and library views land in later
          milestones — see <code>docs/STATUS.md</code>.
        </p>
      </div>
    </main>
  )
}

export default App

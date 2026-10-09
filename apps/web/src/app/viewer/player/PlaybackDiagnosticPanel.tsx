import { useState } from 'react'

// A deliberate snapshot stays on this device and can be copied with ordinary text controls
export function PlaybackDiagnosticPanel({ capture }: { capture: () => string }) {
  const [snapshot, setSnapshot] = useState('')
  return (
    <details className="mv-diagnostics">
      <summary>Playback diagnostics</summary>
      <p>Local event timings and playback state. No filenames, addresses or subtitle text.</p>
      <button className="btn" onClick={() => setSnapshot(capture())}>
        Capture diagnostics
      </button>
      {snapshot && (
        <textarea aria-label="Playback diagnostic snapshot" readOnly value={snapshot} rows={8} />
      )}
    </details>
  )
}

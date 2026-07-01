import { useState } from 'react'

import type { LibraryRead } from '../api/client'

interface LockScreenProps {
  libraries: LibraryRead[]
  libraryId: string
  onChangeLibrary: (id: string) => void
  onUnlock: (passphrase: string) => void
  unlocking: boolean
  error?: string | null
}

/**
 * Passphrase gate shown before a protected, locked library's content loads
 * (ADR-0010). Keeps the library selector so the owner can switch to a different
 * library — each protected library has its own lock, so switching shows its own
 * screen. No content queries run while this is up.
 */
export function LockScreen({
  libraries,
  libraryId,
  onChangeLibrary,
  onUnlock,
  unlocking,
  error,
}: LockScreenProps) {
  const [passphrase, setPassphrase] = useState('')
  const name = libraries.find((l) => l.id === libraryId)?.name ?? 'Library'

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (passphrase) onUnlock(passphrase)
  }

  return (
    <div className="lockscreen">
      <form className="lockscreen__card" onSubmit={submit}>
        <div className="lockscreen__brand">
          <span>🍃</span> Cairndex
        </div>
        {libraries.length > 1 && (
          <select
            className="edit"
            value={libraryId}
            onChange={(e) => {
              setPassphrase('')
              onChangeLibrary(e.target.value)
            }}
            aria-label="Library"
          >
            {libraries.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        )}
        <div className="lockscreen__title">🔒 {name} is locked</div>
        <input
          className="edit"
          type="password"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          placeholder="Owner passphrase"
          aria-label="Owner passphrase"
          autoFocus
        />
        {error && (
          <div className="lockscreen__error" role="alert">
            {error}
          </div>
        )}
        <button className="lockscreen__submit" type="submit" disabled={unlocking || !passphrase}>
          {unlocking ? 'Unlocking…' : 'Unlock'}
        </button>
      </form>
    </div>
  )
}

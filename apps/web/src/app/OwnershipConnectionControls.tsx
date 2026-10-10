import { useId, useState, useSyncExternalStore } from 'react'
import { getConnections, subscribeConnections } from '../desktop/connections'

interface Props {
  holder: string
  advertisedUrl: string | null
  pending: boolean
  error: string | null
  onConnectTo: (address: string) => void
}

// A server's advertised address can be unavailable on the client's network.
// Alternatives are explicit choices, never inferred from labels or host names.
export function OwnershipConnectionControls({
  holder,
  advertisedUrl,
  pending,
  error,
  onConnectTo,
}: Props) {
  const connections = useSyncExternalStore(subscribeConnections, getConnections)
  const saved = connections.connections.filter(
    (entry) => entry.kind === 'remote' && entry.serverUrl,
  )
  const [expanded, setExpanded] = useState(false)
  const [address, setAddress] = useState('')
  const id = useId()
  const showAlternatives = expanded || Boolean(error) || !advertisedUrl

  return (
    <>
      {advertisedUrl && (
        <button
          className="lockscreen__submit"
          onClick={() => onConnectTo(advertisedUrl)}
          disabled={pending}
        >
          {pending ? 'Connecting…' : `Connect to ${holder}`}
        </button>
      )}
      {error && (
        <p className="lockscreen__error" role="alert">
          {error}
        </p>
      )}
      {!showAlternatives ? (
        <button className="btn" onClick={() => setExpanded(true)} disabled={pending}>
          Use another address
        </button>
      ) : (
        <form
          className="lockscreen__connection"
          onSubmit={(event) => {
            event.preventDefault()
            if (!pending && address.trim()) onConnectTo(address.trim())
          }}
        >
          <p className="lockscreen__hint">
            Use an address for {holder} that this device can reach. Connecting does not take
            ownership of the library.
          </p>
          {saved.length > 0 && (
            <>
              <label className="field-label" htmlFor={`${id}-saved`}>
                Saved server address
              </label>
              <select
                id={`${id}-saved`}
                className="edit"
                disabled={pending}
                value={saved.some((entry) => entry.serverUrl === address) ? address : ''}
                onChange={(event) => setAddress(event.target.value)}
              >
                <option value="">Choose a saved address</option>
                {saved.map((entry) => (
                  <option key={entry.id} value={entry.serverUrl!}>
                    {entry.serverUrl}
                  </option>
                ))}
              </select>
            </>
          )}
          <label className="field-label" htmlFor={`${id}-address`}>
            Server address
          </label>
          <input
            id={`${id}-address`}
            className="edit"
            type="url"
            required
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="https://server.example"
            value={address}
            disabled={pending}
            onChange={(event) => setAddress(event.target.value)}
          />
          <button className="lockscreen__submit" disabled={pending || !address.trim()}>
            Connect using this address
          </button>
        </form>
      )}
    </>
  )
}

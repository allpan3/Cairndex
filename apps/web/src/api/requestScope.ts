// Monotonic request identities fence late work even after switching away and back
let connection = 0
let library = 0
let connectionKey: string | null = null

// Starts a fresh server session without coupling durable keys to a sidecar's ephemeral port
export function advanceConnectionScope(key: string | null): void {
  connection += 1
  connectionKey = key
}

// Invalidates continuations belonging to the previous library
export function advanceLibraryScope(): void {
  library += 1
}

// Returns the durable server identity used for private browser drafts
export function getConnectionScopeKey(): string | null {
  return connectionKey
}

// Captures a guard before asynchronous work; callers check it before each continuation
export function captureRequestScope(
  includeLibrary = true,
  version = requestScopeVersion(includeLibrary),
): () => void {
  return () => {
    if (requestScopeVersion(includeLibrary) !== version)
      throw new Error(
        'The active connection or library changed. Previous work has been stopped; any draft is retained.',
      )
  }
}

// Memoization identity changes even when a library or server is selected again
export function requestScopeVersion(includeLibrary = true): string {
  return `${connection}:${includeLibrary ? library : ''}`
}

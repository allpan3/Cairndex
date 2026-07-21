import type { ReactNode } from 'react'

import type { LibraryRead } from '../api/client'

/**
 * The full-screen card shown instead of the workspace when a library cannot be
 * mounted — locked (ADR-0010), inaccessible, or owned by another server
 * (ADR-0018). Extracted from `App` so the ownership notice can reuse it rather
 * than growing a second, subtly different card.
 *
 * It keeps the library picker so the user is never stranded: whatever is wrong
 * with *this* library, switching to another one is still one click away.
 */
export function LibraryAccessNotice({
  libraries,
  libraryId,
  onChangeLibrary,
  title,
  message,
  children,
}: {
  libraries: LibraryRead[]
  libraryId: string
  onChangeLibrary: (id: string) => void
  title: string
  message: string
  children?: ReactNode
}) {
  return (
    <div className="lockscreen">
      <section className="lockscreen__card">
        <div className="lockscreen__brand">
          <span>🍃</span> Cairndex
        </div>
        {libraries.length > 1 && (
          <select
            className="edit"
            value={libraryId}
            onChange={(event) => onChangeLibrary(event.target.value)}
            aria-label="Library"
          >
            {libraries.map((library) => (
              <option key={library.id} value={library.id}>
                {library.name}
              </option>
            ))}
          </select>
        )}
        <div className="lockscreen__title">{title}</div>
        <p className="lockscreen__message">{message}</p>
        {children}
      </section>
    </div>
  )
}

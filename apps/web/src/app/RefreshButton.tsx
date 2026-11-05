import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { IconRefresh } from './icons'

/**
 * Reads what the window shows again: the folder listing, the bundles of the
 * current collection, the inspector's file details and the sidebar.
 *
 * Every query is marked stale; the ones on screen refetch now and the rest when
 * they are next shown. That is what a window-focus refetch already does after 30
 * seconds, without the wait. It does not look for new, moved or missing files
 * across the library: that is Update, which is slower on a large library.
 */
export function RefreshButton() {
  const queryClient = useQueryClient()
  // A local refetch settles before anything visibly changes, so each click
  // turns the icon once to say it registered; the key restarts the turn
  const [clicks, setClicks] = useState(0)
  return (
    <button
      className={`seg toolbar__panel-toggle${clicks ? ' toolbar__refresh--turning' : ''}`}
      onClick={() => {
        setClicks((count) => count + 1)
        void queryClient.invalidateQueries()
      }}
      aria-label="Refresh"
      title="Refresh"
    >
      <IconRefresh key={clicks} />
    </button>
  )
}

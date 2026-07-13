import { useQuery } from '@tanstack/react-query'

import { parseStoryboardVtt } from './storyboardVtt'

// Fetch and parse a storyboard index, treating absence as an optional feature
async function fetchStoryboard(url: string, signal?: AbortSignal) {
  const response = await fetch(url, { signal })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`Storyboard request failed (${response.status})`)
  const cues = parseStoryboardVtt(await response.text())
  return cues.length > 0 ? cues : null
}

// Lazily fetch and cache one optional storyboard index
export function useStoryboardCues(storyboardUrl: string | null, enabled = true, immutable = true) {
  return useQuery({
    queryKey: ['storyboard-vtt', storyboardUrl],
    queryFn: ({ signal }) => fetchStoryboard(storyboardUrl!, signal),
    enabled: enabled && storyboardUrl !== null,
    retry: false,
    // Manifest-provided URLs are fingerprint-versioned and immutable. Hover's
    // cached-only probe URL is not versioned, so refresh it occasionally; a
    // negative lookup also expires after a Generate storyboards run.
    staleTime: (query) => (immutable && query.state.data !== null ? Infinity : 30_000),
  })
}

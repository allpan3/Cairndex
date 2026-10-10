// Shared read controls select the catalog protocol inside a library-scoped provider.
import { createContext } from 'react'
import { catalog } from './catalog'
import { captureRequestScope } from './requestScope'

export const CatalogQueryContext = createContext<string | null>(null)

export async function catalogNavigation<T>(library: string, family: string): Promise<T[]> {
  const assertScope = captureRequestScope()
  const items: T[] = []
  let after = ''
  do {
    assertScope()
    const page = await catalog<{ items: T[]; next_cursor: string | null }>(
      library,
      `/navigation/${family}?after=${encodeURIComponent(after)}&limit=50`,
    )
    assertScope()
    items.push(...page.items)
    after = page.next_cursor ?? ''
  } while (after)
  return items
}

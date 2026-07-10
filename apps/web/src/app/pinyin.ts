import { useEffect, useState } from 'react'

// Approximate first-letter bucketing for alphabet segmentation, with no external
// dependency. Latin → its uppercase letter; digits → '#'; CJK ideographs → their
// pinyin initial (via boundary characters + zh collation); everything else (kana,
// symbols, punctuation) → 'Others'. The CJK mapping is ICU-dependent and only
// approximate at bucket edges, but it's plenty for grouping a tag list.

const ZH = new Intl.Collator('zh-Hans-u-co-pinyin', { sensitivity: 'base' })

// The first character (in pinyin order) of each initial's bucket. A CJK char maps
// to the largest boundary that sorts ≤ it. (Pinyin has no I/U/V initials.)
const BOUNDS: readonly [string, string][] = [
  ['A', '阿'],
  ['B', '八'],
  ['C', '嚓'],
  ['D', '咑'],
  ['E', '妸'],
  ['F', '发'],
  ['G', '旮'],
  ['H', '铪'],
  ['J', '丌'],
  ['K', '喀'],
  ['L', '垃'],
  ['M', '妈'],
  ['N', '拿'],
  ['O', '喔'],
  ['P', '趴'],
  ['Q', '七'],
  ['R', '然'],
  ['S', '撒'],
  ['T', '塌'],
  ['W', '挖'],
  ['X', '昔'],
  ['Y', '压'],
  ['Z', '匝'],
]

const CJK = /[㐀-鿿]/

type PinyinMatcher = (typeof import('pinyin-pro'))['match']

let pinyinMatcher: PinyinMatcher | null = null
let pinyinLoading: Promise<void> | null = null

// Load the offline pinyin dictionary only after a search can use it
export function preparePinyinSearch(): Promise<void> {
  if (pinyinMatcher) return Promise.resolve()
  pinyinLoading ??= import('pinyin-pro').then(({ match }) => {
    pinyinMatcher = match
  })
  return pinyinLoading
}

// Normalize literal matching without changing the displayed or created value
function normalizeSearch(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase()
}

/** Match a normal substring or a contiguous full/initial/mixed pinyin query */
export function matchesSearch(text: string, query: string): boolean {
  const needle = normalizeSearch(query.trim())
  if (!needle) return true
  if (normalizeSearch(text).includes(needle)) return true
  return (
    pinyinMatcher !== null &&
    CJK.test(text) &&
    pinyinMatcher(text, needle, { continuous: true, v: true }) !== null
  )
}

/** Return a matcher that lazy-loads pinyin support for the current query */
export function usePinyinSearch(query: string): (text: string) => boolean {
  const [ready, setReady] = useState(pinyinMatcher !== null)
  useEffect(() => {
    if (ready) return
    let active = true
    void preparePinyinSearch().then(() => {
      if (active) setReady(true)
    })
    return () => {
      active = false
    }
  }, [ready])
  return (text: string) => matchesSearch(text, query)
}

/** The alphabet-section bucket for a tag name: 'A'..'Z', '#' (digit), or 'Others'. */
export function alphaBucket(name: string): string {
  const ch = name.trim().charAt(0)
  if (!ch) return 'Others'
  if (ch >= '0' && ch <= '9') return '#'
  if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')) return ch.toUpperCase()
  if (CJK.test(ch)) {
    if (ZH.compare(ch, BOUNDS[0]![1]) < 0) return 'Others'
    for (let i = BOUNDS.length - 1; i >= 0; i--) {
      if (ZH.compare(ch, BOUNDS[i]![1]) >= 0) return BOUNDS[i]![0]
    }
  }
  return 'Others'
}

/** Section sort key: A..Z first, then '#', then 'Others' last. */
export function bucketOrder(bucket: string): number {
  if (bucket === '#') return 100
  if (bucket === 'Others') return 101
  return bucket.charCodeAt(0)
}

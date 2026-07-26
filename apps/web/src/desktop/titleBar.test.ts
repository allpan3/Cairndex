import { describe, expect, it } from 'vitest'

import { markOverlayTitleBar } from './titleBar'

function freshDoc(): Document {
  return document.implementation.createHTMLDocument('t')
}

describe('markOverlayTitleBar', () => {
  it('marks a macOS shell document, so the app reserves the traffic-light corner', () => {
    const doc = freshDoc()
    markOverlayTitleBar(doc, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15')
    expect(doc.documentElement.dataset.titlebar).toBe('overlay')
  })

  it('leaves other platforms alone — they keep a real title bar', () => {
    const doc = freshDoc()
    markOverlayTitleBar(doc, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
    expect(doc.documentElement.dataset.titlebar).toBeUndefined()
    markOverlayTitleBar(doc, 'Mozilla/5.0 (X11; Linux x86_64)')
    expect(doc.documentElement.dataset.titlebar).toBeUndefined()
  })
})

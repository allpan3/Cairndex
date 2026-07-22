import '@testing-library/jest-dom/vitest'

// jsdom has no layout engine, so ResizeObserver (used by the virtualized
// browser to measure its width) is undefined. Stub it so components mount;
// real grid rendering is covered by the Playwright e2e in a real browser.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = globalThis.ResizeObserver ?? (ResizeObserverStub as never)

// Same reason: with no layout there is nothing to scroll, so jsdom leaves
// scrollIntoView undefined and any keyboard navigation that keeps its active
// item visible would throw in tests while working in every real browser.
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? function () {}

import { expect, test } from 'vitest'
import { fitPanelWidths } from './usePanelWidths'

test('preserves preferred widths whenever the listing has room', () => {
  expect(fitPanelWidths(1440, 400, 480)).toEqual({ sidebar: 400, inspector: 480 })
  expect(fitPanelWidths(960, 240, 300)).toEqual({ sidebar: 240, inspector: 300 })
})

test('reserves 400 pixels for the listing without exceeding panel preferences', () => {
  const { sidebar, inspector } = fitPanelWidths(960, 400, 480)
  expect(sidebar + inspector).toBeCloseTo(560)
  expect(sidebar).toBeGreaterThanOrEqual(180)
  expect(inspector).toBeGreaterThanOrEqual(220)
  expect(fitPanelWidths(800, 400, 480)).toEqual({ sidebar: 180, inspector: 220 })
})

test('hidden panels reserve no space and showing them does not change preferred widths', () => {
  expect(fitPanelWidths(960, 0, 480)).toEqual({ sidebar: 0, inspector: 480 })
  expect(fitPanelWidths(960, 400, 0)).toEqual({ sidebar: 400, inspector: 0 })
  expect(fitPanelWidths(960, 0, 0)).toEqual({ sidebar: 0, inspector: 0 })
})

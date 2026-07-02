import { describe, expect, it } from 'vitest'

import { alphaBucket, bucketOrder } from './pinyin'

describe('alphaBucket', () => {
  it('buckets Latin by uppercase first letter', () => {
    expect(alphaBucket('solo')).toBe('S')
    expect(alphaBucket('TODO/剪辑')).toBe('T')
    expect(alphaBucket('60fps')).toBe('#')
  })
  it('buckets digits into #', () => {
    expect(alphaBucket('3d')).toBe('#')
  })
  it('buckets common CJK by pinyin initial', () => {
    expect(alphaBucket('摄影')).toBe('S') // shè
    expect(alphaBucket('天空')).toBe('T') // tiān
    expect(alphaBucket('云端')).toBe('Y') // yún
    expect(alphaBucket('字幕')).toBe('Z') // zì
  })
  it('sends kana / symbols / empty to Others', () => {
    expect(alphaBucket('ゆいか')).toBe('Others')
    expect(alphaBucket('★')).toBe('Others')
    expect(alphaBucket('   ')).toBe('Others')
  })
})

describe('bucketOrder', () => {
  it('orders A..Z, then #, then Others', () => {
    expect(bucketOrder('A')).toBeLessThan(bucketOrder('Z'))
    expect(bucketOrder('Z')).toBeLessThan(bucketOrder('#'))
    expect(bucketOrder('#')).toBeLessThan(bucketOrder('Others'))
  })
})

import { describe, expect, it } from 'vitest'
import { viewTransitionName } from '@/features/book/lib/sync-chain-view'
import { chainRowStyle, frameChromeClass } from '../chain-ui'

describe('frameChromeClass', () => {
  it('gives a spine row its own card chrome', () => {
    expect(frameChromeClass('spine', 'plain').split(' ')).toEqual(expect.arrayContaining(['rounded-xl', 'border', 'border-border', 'bg-card']))
    expect(frameChromeClass('spine', 'thisBook').split(' ')).toEqual(expect.arrayContaining(['border-primary', 'bg-card']))
    expect(frameChromeClass('spine', 'dashed').split(' ')).toEqual(expect.arrayContaining(['border-dashed', 'bg-transparent']))
    expect(frameChromeClass('spine', 'dashedFilled').split(' ')).toEqual(expect.arrayContaining(['border-dashed', 'bg-card']))
  })

  it('drops every chrome inside the audio group box', () => {
    for (const chrome of ['plain', 'thisBook', 'dashed', 'dashedFilled'] as const) expect(frameChromeClass('group', chrome)).toBe('')
  })
})

describe('chainRowStyle', () => {
  it('names the row for view transitions', () => {
    expect(chainRowStyle('card:ebook')).toEqual({ viewTransitionName: viewTransitionName('card:ebook') })
  })
})

import { describe, expect, it } from 'vitest'
import { workFixture } from '../testing/work-fixture'
import { humanizeKey, kindPillLabel, reviewReasons } from './review-reasons'

const labels: Record<string, string> = {
  'monitored.panel.banner.verdict.probable': 'Probable',
  'monitored.panel.banner.verdict.suspect': 'Suspect',
  'monitored.panel.flags.single_source': 'Single source',
  'monitored.review.badges.collection': 'Collection',
  'monitored.filters.hidden': 'Hidden by you',
}
const t = (key: string) => labels[key] ?? key
const te = (key: string) => key in labels

describe('reviewReasons', () => {
  it('lists the verdict and each flag for an unconfirmed work', () => {
    const work = workFixture({ verdict: 'probable', flags: ['single_source' as never] })
    expect(reviewReasons(work, t, te)).toEqual(['Probable', 'Single source'])
  })

  it('humanizes a flag that has no label', () => {
    const work = workFixture({ verdict: 'verified', flags: ['audio_episode' as never] })
    expect(reviewReasons(work, t, te)).toEqual(['Audio episode'])
  })

  it('returns nothing for a verified, unflagged work', () => {
    expect(reviewReasons(workFixture(), t, te)).toEqual([])
  })

  it('returns nothing once the owner has decided', () => {
    const work = workFixture({ verdict: 'suspect', userVisibility: 'visible' })
    expect(reviewReasons(work, t, te)).toEqual([])
  })
})

describe('humanizeKey', () => {
  it('turns underscores into spaces and capitalizes', () => {
    expect(humanizeKey('split_part')).toBe('Split part')
  })
})

describe('kindPillLabel', () => {
  it('falls back to the humanized kind', () => {
    expect(kindPillLabel('collection', t, te)).toBe('Collection')
    expect(kindPillLabel('dramatization', t, te)).toBe('Dramatization')
  })
})

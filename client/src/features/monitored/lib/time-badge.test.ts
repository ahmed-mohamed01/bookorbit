import { describe, expect, it } from 'vitest'
import { releaseTimeBadge } from './time-badge'

const translate = (key: string, named?: Record<string, unknown>) => `${key}${named ? ` ${JSON.stringify(named)}` : ''}`
const now = new Date(2026, 9, 15)

describe('releaseTimeBadge', () => {
  it('counts days for a release within the last year', () => {
    expect(releaseTimeBadge('2026-01-01', translate, now)).toEqual({ label: 'monitored.releases.daysAgo {"count":287}', upcoming: false })
  })

  it('names the year once a release is more than a year old', () => {
    expect(releaseTimeBadge('2024-05-20', translate, now)).toEqual({ label: '2024', upcoming: false })
  })

  it('counts days forward however far away an upcoming release is', () => {
    expect(releaseTimeBadge('2028-01-01', translate, now)?.upcoming).toBe(true)
    expect(releaseTimeBadge('2028-01-01', translate, now)?.label).toMatch(/^monitored\.releases\.inDays/)
  })
})

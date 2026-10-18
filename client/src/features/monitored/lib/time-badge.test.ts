import { describe, expect, it } from 'vitest'
import { relativeReleaseLabel, releaseTimeBadge } from './time-badge'

const translate = (key: string, named?: Record<string, unknown>) => `${key}${named ? ` ${JSON.stringify(named)}` : ''}`
const now = new Date(2026, 9, 15)

describe('releaseTimeBadge', () => {
  it('counts days for a release within 90 days', () => {
    expect(releaseTimeBadge('2026-09-20', translate, now)).toEqual({ label: 'monitored.releases.daysAgo {"count":25}', upcoming: false })
    expect(releaseTimeBadge('2027-01-13', translate, now)).toEqual({ label: 'monitored.releases.inDays {"count":90}', upcoming: true })
  })

  it('counts months between 90 days and a year', () => {
    expect(releaseTimeBadge('2026-01-01', translate, now)).toEqual({ label: 'monitored.releases.monthsAgo {"count":9}', upcoming: false })
    expect(releaseTimeBadge('2027-03-15', translate, now)).toEqual({ label: 'monitored.releases.inMonths {"count":5}', upcoming: true })
  })

  it('names the year once a release is more than a year old', () => {
    expect(releaseTimeBadge('2024-05-20', translate, now)).toEqual({ label: '2024', upcoming: false })
  })

  it('counts years for a release more than a year ahead', () => {
    expect(releaseTimeBadge('2028-11-29', translate, now)).toEqual({ label: 'monitored.releases.inYears {"count":2}', upcoming: true })
  })
})

describe('relativeReleaseLabel', () => {
  it('reads today, then days, months and years in both directions', () => {
    expect(relativeReleaseLabel(0, translate)).toBe('monitored.releases.today')
    expect(relativeReleaseLabel(-90, translate)).toBe('monitored.releases.daysAgo {"count":90}')
    expect(relativeReleaseLabel(91, translate)).toBe('monitored.releases.inMonths {"count":3}')
    expect(relativeReleaseLabel(-290, translate)).toBe('monitored.releases.monthsAgo {"count":10}')
    expect(relativeReleaseLabel(-500, translate)).toBe('monitored.releases.yearsAgo {"count":1}')
    expect(relativeReleaseLabel(1505, translate)).toBe('monitored.releases.inYears {"count":4}')
  })
})

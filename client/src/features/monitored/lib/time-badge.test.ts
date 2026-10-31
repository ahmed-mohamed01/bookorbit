import { describe, expect, it } from 'vitest'
import { relativeReleaseLabel, releaseTimeBadge } from './time-badge'

const now = new Date(2026, 9, 15)

describe('releaseTimeBadge', () => {
  it('counts days for a release within 90 days', () => {
    expect(releaseTimeBadge('2026-09-20', now)).toEqual({ label: '25 days ago', upcoming: false })
    expect(releaseTimeBadge('2027-01-13', now)).toEqual({ label: 'in 90 days', upcoming: true })
  })

  it('counts months between 90 days and a year', () => {
    expect(releaseTimeBadge('2026-01-01', now)).toEqual({ label: '9 months ago', upcoming: false })
    expect(releaseTimeBadge('2027-03-15', now)).toEqual({ label: 'in 5 months', upcoming: true })
  })

  it('names the year once a release is more than a year old', () => {
    expect(releaseTimeBadge('2024-05-20', now)).toEqual({ label: '2024', upcoming: false })
  })

  it('counts years for a release more than a year ahead', () => {
    expect(releaseTimeBadge('2028-11-29', now)).toEqual({ label: 'in 2 years', upcoming: true })
  })
})

describe('relativeReleaseLabel', () => {
  it('reads today, then days, months and years in both directions', () => {
    expect(relativeReleaseLabel(0)).toBe('today')
    expect(relativeReleaseLabel(1)).toBe('tomorrow')
    expect(relativeReleaseLabel(-90)).toBe('90 days ago')
    expect(relativeReleaseLabel(91)).toBe('in 3 months')
    expect(relativeReleaseLabel(-290)).toBe('10 months ago')
    expect(relativeReleaseLabel(-500)).toBe('last year')
    expect(relativeReleaseLabel(1505)).toBe('in 4 years')
  })
})

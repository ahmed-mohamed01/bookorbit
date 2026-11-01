import { describe, expect, it } from 'vitest'
import { describeNextRun } from '../next-run'

const NOW = new Date(2026, 10, 1, 14, 0, 0)

describe('describeNextRun', () => {
  it('calls a late evening start tonight', () => {
    expect(describeNextRun(new Date(2026, 10, 1, 22, 30).toISOString(), NOW).day).toBe('tonight')
  })

  it('calls a small hours start tomorrow tonight', () => {
    expect(describeNextRun(new Date(2026, 10, 2, 2, 0).toISOString(), NOW).day).toBe('tonight')
  })

  it('keeps daytime starts as today or tomorrow', () => {
    expect(describeNextRun(new Date(2026, 10, 1, 16, 0).toISOString(), NOW).day).toBe('today')
    expect(describeNextRun(new Date(2026, 10, 2, 9, 0).toISOString(), NOW).day).toBe('tomorrow')
  })

  it('falls back to a dated label further out', () => {
    expect(describeNextRun(new Date(2026, 10, 9, 2, 0).toISOString(), NOW).day).toBe('later')
  })
})

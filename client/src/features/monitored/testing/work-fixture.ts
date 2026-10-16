import type { MonitoredWork } from '@bookorbit/types'

export const TODAY = '2026-10-15'

export function workFixture(overrides: Partial<MonitoredWork> = {}): MonitoredWork {
  return {
    id: 'work-1',
    title: 'A Book',
    subtitle: null,
    seriesName: null,
    seriesIndex: null,
    seriesMemberships: [],
    releaseYear: null,
    ebookReleaseDate: '2020-01-01',
    ebookDatePrecision: 'day',
    audioReleaseDate: '2020-01-01',
    audioDatePrecision: 'day',
    coverUrl: null,
    description: null,
    verdict: 'verified',
    flags: [],
    sources: [],
    providerWorkIds: {},
    monitorState: 'monitoring',
    matchedBookId: null,
    ownedFormats: [],
    requestIds: {},
    ...overrides,
  }
}

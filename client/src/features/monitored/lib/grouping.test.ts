import { describe, expect, it, vi } from 'vitest'
import type { MonitoredFormat, MonitoredReleaseItem, MonitoredWork } from '@bookorbit/types'
import { collapseReleaseItems, groupWorks, releaseDateForWork, seriesMembershipForGroup, sortWorks } from './grouping'

function work(overrides: Partial<MonitoredWork> & Pick<MonitoredWork, 'id' | 'title'>): MonitoredWork {
  const { id, title, ...rest } = overrides
  return {
    id,
    title,
    subtitle: null,
    seriesName: null,
    seriesIndex: null,
    seriesMemberships: [],
    releaseYear: null,
    ebookReleaseDate: null,
    ebookDatePrecision: null,
    audioReleaseDate: null,
    audioDatePrecision: null,
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
    ...rest,
  }
}

describe('monitored work grouping', () => {
  it('uses the earliest format date and falls back to release year', () => {
    expect(releaseDateForWork(work({ id: 'a', title: 'A', ebookReleaseDate: '2027-02-01', audioReleaseDate: '2026-12-01' }))).toBe('2026-12-01')
    expect(releaseDateForWork(work({ id: 'b', title: 'B', releaseYear: 1999 }))).toBe('1999-01-01')
  })

  it('sorts by date in both directions while keeping unknown dates last', () => {
    const values = [
      work({ id: 'unknown', title: 'Unknown' }),
      work({ id: 'new', title: 'New', ebookReleaseDate: '2026-01-01' }),
      work({ id: 'old', title: 'Old', ebookReleaseDate: '2020-01-01' }),
    ]
    expect(sortWorks(values, 'releaseDate', 'asc').map(({ id }) => id)).toEqual(['old', 'new', 'unknown'])
    expect(sortWorks(values, 'releaseDate', 'desc').map(({ id }) => id)).toEqual(['new', 'old', 'unknown'])
  })

  it('groups series alphabetically with standalone books last', () => {
    const values = [
      work({ id: 'solo', title: 'Solo' }),
      work({ id: 'z', title: 'Z', seriesName: 'Zeta', seriesMemberships: [{ name: 'Zeta', index: null }] }),
      work({ id: 'a', title: 'A', seriesName: 'Alpha', seriesMemberships: [{ name: 'Alpha', index: null }] }),
    ]
    expect(groupWorks(values, 'series', 'desc', 'releaseDate').map(({ label }) => label)).toEqual(['Alpha', 'Zeta', 'Standalone'])
  })

  it('orders series sections by earliest release date and honours the sort/order toggle', () => {
    const values = [
      work({ id: 'zeta-1', title: 'Zeta One', ebookReleaseDate: '2020-01-01', seriesMemberships: [{ name: 'Zeta', index: '1' }] }),
      work({ id: 'alpha-1', title: 'Alpha One', ebookReleaseDate: '2026-01-01', seriesMemberships: [{ name: 'Alpha', index: '1' }] }),
    ]
    // Newest series first when sorting by release date descending.
    expect(groupWorks(values, 'series', 'desc', 'releaseDate').map(({ label }) => label)).toEqual(['Alpha', 'Zeta'])
    // Oldest series first when ascending.
    expect(groupWorks(values, 'series', 'asc', 'releaseDate').map(({ label }) => label)).toEqual(['Zeta', 'Alpha'])
    // Title sort orders the sections by series name instead.
    expect(groupWorks(values, 'series', 'asc', 'title').map(({ label }) => label)).toEqual(['Alpha', 'Zeta'])
    expect(groupWorks(values, 'series', 'desc', 'title').map(({ label }) => label)).toEqual(['Zeta', 'Alpha'])
  })

  it('fans a work into every series and sorts by each membership position', () => {
    const multiSeries = work({
      id: 'tress',
      title: 'Tress of the Emerald Sea',
      seriesName: "Hoid's Travails",
      seriesIndex: '1',
      seriesMemberships: [
        { name: "Hoid's Travails", index: '1' },
        { name: 'Secret Projects', index: '1' },
        { name: 'The Cosmere', index: '29' },
      ],
    })
    const groups = groupWorks(
      [
        work({ id: 'secret-zero', title: 'Secret Zero', seriesMemberships: [{ name: 'Secret Projects', index: '0' }] }),
        work({ id: 'cosmere-ten', title: 'Cosmere Ten', seriesMemberships: [{ name: 'The Cosmere', index: '10' }] }),
        multiSeries,
      ],
      'series',
      'desc',
      'releaseDate',
    )

    expect(groups.find(({ key }) => key === "Hoid's Travails")?.works.map(({ id }) => id)).toEqual(['tress'])
    expect(groups.find(({ key }) => key === 'Secret Projects')?.works.map(({ id }) => id)).toEqual(['secret-zero', 'tress'])
    expect(groups.find(({ key }) => key === 'The Cosmere')?.works.map(({ id }) => id)).toEqual(['cosmere-ten', 'tress'])
    expect(seriesMembershipForGroup(multiSeries, 'The Cosmere')).toEqual({ name: 'The Cosmere', index: '29' })
  })

  it('orders year groups using the selected direction', () => {
    const values = [work({ id: 'a', title: 'A', releaseYear: 2020 }), work({ id: 'b', title: 'B', releaseYear: 2025 })]
    expect(groupWorks(values, 'year', 'asc', 'releaseDate').map(({ label }) => label)).toEqual(['2020', '2025'])
    expect(groupWorks(values, 'year', 'desc', 'releaseDate').map(({ label }) => label)).toEqual(['2025', '2020'])
  })

  it('splits status into upcoming, recent, and backlist', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-03T12:00:00Z'))
    const groups = groupWorks(
      [
        work({ id: 'upcoming', title: 'Upcoming', ebookReleaseDate: '2026-10-01' }),
        work({ id: 'recent', title: 'Recent', ebookReleaseDate: '2026-01-01' }),
        work({ id: 'backlist', title: 'Backlist', ebookReleaseDate: '2020-01-01' }),
      ],
      'status',
      'desc',
      'releaseDate',
    )
    expect(groups.map(({ key }) => key)).toEqual(['upcoming', 'recent', 'backlist'])
    vi.useRealTimers()
  })
})

describe('collapseReleaseItems', () => {
  function release(workId: string, format: MonitoredFormat, releaseDate: string): MonitoredReleaseItem {
    return {
      workId,
      work: work({ id: workId, title: workId }),
      monitorAuthorId: 'monitor-1',
      title: workId,
      authorName: 'Author',
      coverUrl: null,
      format,
      releaseDate,
      status: 'available',
      isOwner: true,
      requestId: null,
    }
  }

  it('folds sibling format rows into one entry per work, preserving first-seen order', () => {
    const entries = collapseReleaseItems([
      release('songs', 'ebook', '2026-06-16'),
      release('songs', 'audiobook', '2026-06-16'),
      release('hero', 'ebook', '2026-07-10'),
      release('book-of-the-dead', 'audiobook', '2026-08-19'),
      release('hero', 'audiobook', '2026-07-28'),
    ])
    expect(entries.map(({ work: entryWork }) => entryWork.id)).toEqual(['songs', 'hero', 'book-of-the-dead'])
    expect(entries[0].items.map(({ format }) => format)).toEqual(['ebook', 'audiobook'])
    expect(entries[1].items.map(({ releaseDate }) => releaseDate)).toEqual(['2026-07-10', '2026-07-28'])
    expect(entries[2].items).toHaveLength(1)
  })
})

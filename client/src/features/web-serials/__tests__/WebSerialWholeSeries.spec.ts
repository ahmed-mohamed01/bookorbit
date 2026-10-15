import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { WebSerialSeriesMatch, WebSerialSourceOption } from '@bookorbit/types'
import { i18n } from '@/i18n'
import WebSerialSources from '../components/preview/WebSerialSources.vue'
import WebSerialCredits from '../components/preview/WebSerialCredits.vue'

function option(overrides: Partial<WebSerialSourceOption>): WebSerialSourceOption {
  return {
    seriesKey: 'nl:a',
    sourceName: 'Light Novel Pub',
    title: 'The Water Magician: The Central Provinces Arc',
    chapterCount: 40,
    latestAt: null,
    confidence: 'title_match',
    mostComplete: false,
    ...overrides,
  }
}

const centralArc: WebSerialSeriesMatch = {
  provider: 'mangabaka',
  id: '20',
  title: 'The Water Magician: The Central Provinces Arc',
  url: 'https://mangabaka.org/20',
  year: 2021,
  authors: ['Tadashi Kubou'],
  artists: [],
  status: 'ongoing',
  genres: ['Fantasy'],
}

function mountSources(options: WebSerialSourceOption[]) {
  return mount(WebSerialSources, {
    props: { options, state: 'ready', selectedKey: options[0]!.seriesKey, disabled: false, discover: true, entryState: 'ready' },
    global: { plugins: [i18n] },
  })
}

function mountCredits(match: WebSerialSeriesMatch) {
  return mount(WebSerialCredits, {
    props: { state: 'matched', match, message: '', authors: match.authors, artists: [], showArtists: false },
    global: { plugins: [i18n] },
  })
}

describe('whole series filed in parts', () => {
  it('marks a whole-series source with its chip and a note, and only that one', () => {
    const wrapper = mountSources([
      option({
        seriesKey: 'nl:fire',
        sourceName: 'Novel Fire',
        title: 'Water Magician',
        chapterCount: 800,
        confidence: 'whole_series',
        mostComplete: true,
      }),
      option({ seriesKey: 'nl:pub', sourceName: 'Light Novel Pub' }),
    ])

    const rows = wrapper.findAll('label')
    expect(rows[0]!.text()).toContain('Whole series')
    expect(rows[0]!.find('[data-testid="whole-series-note"]').text()).toBe(
      'This site has the whole series, not just this part. Its volumes are blocks of 100 chapters.',
    )
    expect(rows[1]!.text()).toContain('Title match')
    expect(rows[1]!.find('[data-testid="whole-series-note"]').exists()).toBe(false)
  })

  it('says the details come from the first part when the match covers only a part', () => {
    expect(mountCredits({ ...centralArc, scope: 'part' }).text()).toContain(
      'Details from MangaBaka: The Water Magician: The Central Provinces Arc (first part of the series)',
    )
    expect(mountCredits(centralArc).text()).toContain('Details from MangaBaka: The Water Magician: The Central Provinces Arc (2021)')
  })
})

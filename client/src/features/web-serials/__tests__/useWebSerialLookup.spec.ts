import { describe, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'
import { flushPromises } from '@vue/test-utils'
import type { WebSerialSeriesLookup, WebSerialSeriesMatch } from '@bookorbit/types'

const api = vi.hoisted(() => ({ fetchSeriesLookup: vi.fn<(...args: unknown[]) => Promise<WebSerialSeriesLookup>>() }))
vi.mock('../api/webSerials', () => api)

import { matchOfEntry } from '../composables/useWebSerialEntryPreview'
import { useWebSerialLookup } from '../composables/useWebSerialLookup'
import { entryFromSuggestion } from '../lib/serialSuggest'
import { novelDetail, suggestion } from './fixtures'

const FULL: WebSerialSeriesMatch = {
  provider: 'mangabaka',
  id: '77',
  title: 'Omniscient Reader',
  url: 'https://mangabaka.org/77',
  year: 2018,
  authors: ['Sing Shong'],
  artists: [],
  status: 'completed',
  genres: ['Action'],
  publication: { licensed: true, finalVolume: 12, publishers: [] },
} as WebSerialSeriesMatch

function setupFromSuggestion() {
  const entry = entryFromSuggestion({ ...suggestion(), matchId: '77' })
  const preset = computed(() => matchOfEntry(entry))
  const detail = ref(novelDetail({ author: 'singNsong (site)' }))
  return useWebSerialLookup(detail, preset)
}

describe('a series opened from a suggestion', () => {
  it('uses the server match for the same id instead of the stub', async () => {
    api.fetchSeriesLookup.mockResolvedValue({ state: 'matched', message: null, chapterVolumes: null, match: FULL })
    const lookup = setupFromSuggestion()
    await flushPromises()
    expect(lookup.authors.value).toEqual(['Sing Shong'])
    expect(lookup.match.value?.publication?.licensed).toBe(true)
    expect(lookup.match.value?.status).toBe('completed')
    expect(lookup.metadata()).toEqual({ matchId: '77', authors: ['Sing Shong'] })
  })

  it('keeps the preset when the server matched another id', async () => {
    api.fetchSeriesLookup.mockResolvedValue({ state: 'matched', message: null, chapterVolumes: null, match: { ...FULL, id: '99' } })
    const lookup = setupFromSuggestion()
    await flushPromises()
    expect(lookup.match.value?.id).toBe('77')
  })

  it('does not send the site author as an override when the lookup could not answer', async () => {
    api.fetchSeriesLookup.mockRejectedValue(new Error('down'))
    const lookup = setupFromSuggestion()
    await flushPromises()
    expect(lookup.authors.value).toEqual(['singNsong (site)'])
    expect(lookup.metadata()).toEqual({ matchId: '77' })
    lookup.setAuthors(['Edited'])
    expect(lookup.metadata()).toEqual({ matchId: '77', authors: ['Edited'] })
  })
})

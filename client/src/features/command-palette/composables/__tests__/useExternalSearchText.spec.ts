import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import { useExternalSearchText, type ExternalProvider } from '../useExternalSearchText'

const NAMES: Record<string, string> = {
  'commandPalette.external.providers.hardcover': 'Hardcover',
  'commandPalette.external.providers.manga': 'manga',
  'commandPalette.external.providers.lightNovels': 'light novels',
  'commandPalette.external.descriptionProviders': 'Find more to follow, request or download',
  'commandPalette.external.descriptionProvidersHidden': 'Find more to follow or download',
}

function t(key: string, params?: Record<string, string>) {
  if (key === 'commandPalette.external.searchProviders') return `Search ${params?.providers} for "${params?.q}"`
  return NAMES[key] ?? key
}

function label(providers: ExternalProvider[]) {
  return useExternalSearchText(ref(providers), ref('overgeared'), ref(true), t, ref('en-GB')).value.label
}

describe('useExternalSearchText', () => {
  it.each([
    [['hardcover'], 'Search Hardcover for "overgeared"'],
    [['manga'], 'Search manga for "overgeared"'],
    [['lightNovels'], 'Search light novels for "overgeared"'],
    [['hardcover', 'manga'], 'Search Hardcover and manga for "overgeared"'],
    [['hardcover', 'lightNovels'], 'Search Hardcover and light novels for "overgeared"'],
    [['manga', 'lightNovels'], 'Search manga and light novels for "overgeared"'],
    [['hardcover', 'manga', 'lightNovels'], 'Search Hardcover, manga and light novels for "overgeared"'],
  ] as Array<[ExternalProvider[], string]>)('names exactly the searched sources: %j', (providers, expected) => {
    expect(label(providers)).toBe(expected)
  })

  it('follows the query and the provider list as they change', () => {
    const providers = ref<ExternalProvider[]>(['hardcover'])
    const query = ref('a')
    const text = useExternalSearchText(providers, query, ref(true), t, ref('en-GB'))
    providers.value = ['manga']
    query.value = 'b'
    expect(text.value.label).toBe('Search manga for "b"')
  })

  it('drops "request" from the description when Requests is hidden', () => {
    const visible = ref(true)
    const text = useExternalSearchText(ref<ExternalProvider[]>(['hardcover']), ref('x'), visible, t, ref('en-GB'))
    expect(text.value.description).toBe('Find more to follow, request or download')
    visible.value = false
    expect(text.value.description).toBe('Find more to follow or download')
  })
})

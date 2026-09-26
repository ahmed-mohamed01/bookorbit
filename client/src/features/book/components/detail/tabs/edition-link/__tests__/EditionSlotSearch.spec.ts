import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { EditionLinkCandidate } from '@bookorbit/types'
import EditionCover from '../EditionCover.vue'
import EditionSlotSearch from '../EditionSlotSearch.vue'
import { withMessages } from './with-messages'

type SearchProps = InstanceType<typeof EditionSlotSearch>['$props']

const candidates: EditionLinkCandidate[] = [
  { bookId: 20, title: 'Dune', authorName: 'Frank Herbert', coverVersion: null, score: 96 },
  { bookId: 21, title: 'Dune Messiah', authorName: null, coverVersion: null, score: 80 },
]

function mountSearch(props: Partial<SearchProps> = {}, attachTo?: HTMLElement) {
  return mount(EditionSlotSearch, {
    attachTo,
    props: {
      format: 'audiobook',
      canSearch: true,
      query: '',
      candidates,
      searching: false,
      searchError: null,
      hasSearched: true,
      disabled: false,
      ...props,
    } as SearchProps,
  })
}

describe('EditionSlotSearch', () => {
  it('names the missing format in the title, body and placeholder', () => {
    const audio = mountSearch()
    expect(audio.text()).toContain('Select a matching audiobook')
    expect(audio.text()).toContain('Pick the audiobook edition')
    expect(audio.get('[data-testid="edition-search-input"]').attributes('placeholder')).toBe('Search audiobooks in your libraries...')

    const ebook = mountSearch({ format: 'ebook' })
    expect(ebook.text()).toContain('Select a matching ebook')
    expect(ebook.get('[data-testid="edition-search-input"]').attributes('placeholder')).toBe('Search ebooks in your libraries...')
  })

  it('lists each result with cover, title, author and a score pill tinted only above 80', () => {
    const wrapper = mountSearch()

    const results = wrapper.findAll('[data-testid="edition-search-result"]')
    expect(results).toHaveLength(2)
    const cover = results[0]?.get('[data-testid="edition-cover"]')
    expect(cover?.attributes('data-medium')).toBe('audio')
    expect(cover?.classes()).toContain('size-8')
    expect(results[0]?.text()).toContain('Dune')
    expect(results[0]?.text()).toContain('Frank Herbert')

    const scores = wrapper.findAll('[data-testid="edition-search-score"]')
    expect(scores.map((score) => score.text())).toEqual(['96%', '80%'])
    expect(scores[0]?.classes()).toContain('text-success')
    expect(scores[1]?.classes()).toContain('text-muted-foreground')
  })

  it('hands each result cover its own cover version', () => {
    const wrapper = mountSearch({
      candidates: [{ ...candidates[0]!, coverVersion: '2026-03-01T00:00:00.000Z' }, candidates[1]!],
    })

    const covers = wrapper.findAllComponents(EditionCover)
    expect(covers.map((cover) => cover.props('version'))).toEqual(['2026-03-01T00:00:00.000Z', null])
  })

  it('reads the score pill from the catalog', async () => {
    await withMessages({ book: { detail: { editionLink: { search: { score: '{score} %' } } } } }, () => {
      const wrapper = mountSearch()

      expect(wrapper.findAll('[data-testid="edition-search-score"]').map((score) => score.text())).toEqual(['96 %', '80 %'])
    })
  })

  it('focuses the input when asked to, and only then', () => {
    const focused = mountSearch({ autofocus: true }, document.body)
    expect(document.activeElement).toBe(focused.get('[data-testid="edition-search-input"]').element)
    focused.unmount()

    const unfocused = mountSearch({}, document.body)
    expect(document.activeElement).not.toBe(unfocused.get('[data-testid="edition-search-input"]').element)
    unfocused.unmount()
  })

  it('emits the picked candidate', async () => {
    const wrapper = mountSearch()

    await wrapper.findAll('[data-testid="edition-search-result"]')[1]?.trigger('click')

    expect(wrapper.emitted('pick')?.[0]).toEqual([candidates[1]])
  })

  it('emits the query as it is typed', async () => {
    const wrapper = mountSearch()

    await wrapper.get('[data-testid="edition-search-input"]').setValue('messiah')

    expect(wrapper.emitted('update:query')?.[0]).toEqual(['messiah'])
  })

  it('shows searching, error and empty states instead of results', () => {
    expect(mountSearch({ searching: true }).text()).toContain('Searching...')
    expect(mountSearch({ searchError: 'boom' }).find('[data-testid="edition-search-error"]').exists()).toBe(true)
    expect(mountSearch({ candidates: [] }).text()).toContain('No matches found.')
    expect(mountSearch({ candidates: [], hasSearched: false }).text()).not.toContain('No matches found.')
  })

  it('offers no search to a user who cannot link', () => {
    const wrapper = mountSearch({ canSearch: false })

    expect(wrapper.find('[data-testid="edition-search-input"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="edition-search-result"]').exists()).toBe(false)
  })

  it('disables picking while a link is being made', () => {
    const wrapper = mountSearch({ disabled: true })

    expect(wrapper.get('[data-testid="edition-search-result"]').attributes('disabled')).toBeDefined()
  })
})

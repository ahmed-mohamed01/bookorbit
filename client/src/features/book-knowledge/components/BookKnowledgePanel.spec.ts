import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BookKnowledgeStatus, BookKnowledgeTermDetail } from '@bookorbit/types'
import BookKnowledgePanel from './BookKnowledgePanel.vue'
import { api } from '@/lib/api'

vi.mock('@/lib/api', () => ({ api: vi.fn<typeof import('@/lib/api').api>() }))
const permissions = vi.hoisted(() => ({ allowed: true }))
vi.mock('@/features/auth/composables/usePermissions', () => ({ usePermissions: () => ({ hasPermission: () => permissions.allowed }) }))
const ready: BookKnowledgeStatus = {
  scope: 'position',
  cutoffOrdinal: 42,
  noProgress: false,
  status: 'ready',
  progress: 100,
  error: null,
  modelConfigured: false,
  enabled: true,
}
const detail: BookKnowledgeTermDetail = {
  scope: 'position',
  cutoffOrdinal: 42,
  noProgress: false,
  cutoffSpineIndex: 0,
  spineHrefs: [{ spineIndex: 0, href: 'chapter-one.xhtml' }],
  term: { key: 'amber engine', displayName: 'amber engine', aliases: ['amber engine'], type: 'concept', count: 3, first: 10, latest: 42, score: 1 },
  histogram: [{ spineIndex: 0, count: 3 }],
  related: [],
  passages: [
    { number: 1, text: 'The amber engine folded the glass map.', ordinals: [42], spineIndex: 0, paragraphIndex: 2, href: 'chapter-one.xhtml' },
  ],
}
function response(data: unknown) {
  return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
}
function mockReady(status = ready) {
  vi.mocked(api).mockImplementation(async (url) => {
    if (String(url).includes('/terms?'))
      return response({ items: [detail.term], total: 1, offset: 0, limit: 50, scope: status.scope, cutoffOrdinal: 42, noProgress: false })
    if (String(url).includes('/terms/')) return response(detail)
    return response(status)
  })
}
const wrappers: ReturnType<typeof mount>[] = []
function panel() {
  const wrapper = mount(BookKnowledgePanel, { props: { bookId: 9 } })
  wrappers.push(wrapper)
  return wrapper
}
describe('Book Knowledge', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    permissions.allowed = true
  })
  afterEach(() => {
    wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
    vi.useRealTimers()
  })
  it('keeps deterministic passages available without a model and emits their locations', async () => {
    mockReady()
    const wrapper = panel()
    await flushPromises()
    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('amber engine'))!
      .trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('No model is configured')
    expect(wrapper.text()).toContain('You are here')
    expect(wrapper.text()).toContain(detail.passages[0]!.text)
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Jump to passage')!
      .trigger('click')
    expect(wrapper.emitted('jump')?.[0]).toEqual([detail.passages[0]])
    expect(api).not.toHaveBeenCalledWith(expect.stringContaining('/card'), expect.anything())
  })
  it('debounces search and never sends a reading position', async () => {
    vi.useFakeTimers()
    mockReady()
    const wrapper = panel()
    await flushPromises()
    await wrapper.get('input[type="search"]').setValue('amber')
    await wrapper.get('input[type="search"]').setValue('amber engine')
    await vi.advanceTimersByTimeAsync(349)
    expect(api).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(api).toHaveBeenLastCalledWith(
      expect.stringContaining('q=amber+engine&limit=50&offset=0&scope=position'),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })
  it('backs off polling only while indexing and stops on unmount', async () => {
    vi.useFakeTimers()
    vi.mocked(api).mockResolvedValue(response({ ...ready, status: 'running' }))
    const wrapper = panel()
    await flushPromises()
    vi.mocked(api).mockResolvedValue(response({ ...ready, status: 'running' }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(api).toHaveBeenCalledTimes(2)
    vi.mocked(api).mockResolvedValue(response({ ...ready, status: 'running' }))
    await vi.advanceTimersByTimeAsync(1499)
    expect(api).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(api).toHaveBeenCalledTimes(3)
    wrapper.unmount()
    await vi.advanceTimersByTimeAsync(30000)
    expect(api).toHaveBeenCalledTimes(3)
  })
  it('aborts old scope requests and clears term details before requesting full scope', async () => {
    mockReady()
    const wrapper = panel()
    await flushPromises()
    await wrapper.get('input[type="search"]').setValue('old')
    const previous = vi.mocked(api).mock.calls.at(-1)?.[1]?.signal
    await wrapper.get('input[type="checkbox"]').setValue(true)
    await flushPromises()
    expect(previous?.aborted).toBe(true)
    expect(api).toHaveBeenCalledWith(expect.stringContaining('scope=full'), expect.anything())
    expect(wrapper.emitted('update:sessionScope')?.[0]).toEqual(['full'])
  })
  it('renders unverified meaning and invented quoted evidence', async () => {
    mockReady({ ...ready, modelConfigured: true })
    vi.mocked(api).mockImplementation(async (url) => {
      if (String(url).includes('/card'))
        return response({
          ...ready,
          card: {
            meaning: 'A map-folding machine.',
            meaningQuote: 'folded the glass map',
            meaningPassage: 1,
            points: [{ text: 'It folds maps.', quote: 'folded the glass map', passage: 1 }],
            insufficient: false,
          },
          checks: { meaningVerified: false, droppedPoints: 0, unknownPassage: false },
          passages: detail.passages,
        })
      if (String(url).includes('/terms?')) return response({ items: [detail.term], total: 1 })
      if (String(url).includes('/terms/')) return response(detail)
      return response({ ...ready, modelConfigured: true })
    })
    const wrapper = panel()
    await flushPromises()
    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('amber engine'))!
      .trigger('click')
    await flushPromises()
    expect(wrapper.find('[title="The meaning quote could not be verified. Check the passages."]').exists()).toBe(true)
    expect(wrapper.text()).toContain('folded the glass map')
    expect(wrapper.findAll('button').some((button) => button.text() === 'Retry')).toBe(false)
  })
  it('defaults to Concepts, orders tabs and explains empty name lists', async () => {
    vi.useFakeTimers()
    mockReady()
    const wrapper = panel()
    await flushPromises()
    expect(wrapper.findAll('[role="tab"]').map((tab) => tab.text())).toEqual(['Concepts', 'People', 'Places'])
    expect(wrapper.find('[aria-selected="true"]').text()).toBe('Concepts')
    vi.mocked(api).mockResolvedValue(response({ items: [], total: 0 }))
    await wrapper.findAll('[role="tab"]')[1]!.trigger('click')
    await vi.advanceTimersByTimeAsync(350)
    await flushPromises()
    expect(wrapper.text()).toContain('No people identified')
    await wrapper.findAll('[role="tab"]')[2]!.trigger('click')
    await vi.advanceTimersByTimeAsync(350)
    await flushPromises()
    expect(wrapper.text()).toContain('No places identified')
  })
  it('maps histogram spine hrefs to nested TOC titles and marks the actual cutoff chapter', async () => {
    mockReady()
    const wrapper = panel()
    await flushPromises()
    await wrapper.setProps({ chapters: [{ label: 'Part', href: 'part.xhtml', subitems: [{ label: 'The Glass Gate', href: 'chapter-one.xhtml' }] }] })
    vi.mocked(api).mockResolvedValue(
      response({
        ...detail,
        cutoffSpineIndex: 5,
        histogram: [
          { spineIndex: 0, count: 2 },
          { spineIndex: 5, count: 1 },
        ],
      }),
    )
    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('amber engine'))!
      .trigger('click')
    await flushPromises()
    const rows = wrapper.findAll('meter').map((meter) => meter.element.parentElement!.textContent!)
    expect(rows[0]).toContain('The Glass Gate')
    expect(rows[0]).not.toContain('You are here')
    expect(rows[1]).toContain('Section 6')
    expect(rows[1]).toContain('You are here')
  })
  it.each([
    ['none', 'This book has not been indexed yet.'],
    ['failed', 'Indexing failed.'],
    ['running', 'Indexing book...'],
  ] as const)('renders the %s index state', async (status, text) => {
    mockReady({ ...ready, status })
    const wrapper = panel()
    await flushPromises()
    expect(wrapper.text()).toContain(text)
    expect(wrapper.find('textarea').attributes('disabled')).toBeDefined()
  })
  it('shows no reading progress and clears position data on a scope change', async () => {
    mockReady({ ...ready, noProgress: true })
    const wrapper = panel()
    await flushPromises()
    expect(wrapper.text()).toContain('No reading progress yet.')
    await wrapper.get('input[type="checkbox"]').setValue(true)
    expect(wrapper.text()).not.toContain('amber engine')
    await flushPromises()
    expect(wrapper.text()).toContain('Showing the whole book may reveal spoilers.')
  })
  it('displays model busy responses without losing deterministic evidence', async () => {
    mockReady({ ...ready, modelConfigured: true })
    const wrapper = panel()
    await flushPromises()
    vi.mocked(api).mockImplementation(async (url) => (String(url).includes('/card') ? new Response('', { status: 503 }) : response(detail)))
    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('amber engine'))!
      .trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('The model is busy.')
    expect(wrapper.findAll('button').some((button) => button.text() === 'Retry')).toBe(true)
    expect(wrapper.text()).toContain(detail.passages[0]!.text)
  })
  it('shows the budget message for a 429 budget reply', async () => {
    mockReady({ ...ready, modelConfigured: true })
    const wrapper = panel()
    await flushPromises()
    vi.mocked(api).mockImplementation(async (url) =>
      String(url).includes('/card') ? new Response(JSON.stringify({ errorCode: 'budget' }), { status: 429 }) : response(detail),
    )
    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('amber engine'))!
      .trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('AI budget is used up')
    expect(wrapper.text()).not.toContain('The model is busy.')
  })
  it('hides Build and points admins to the AI settings when Book Knowledge is turned off', async () => {
    mockReady({ ...ready, status: 'none', enabled: false })
    const wrapper = panel()
    await flushPromises()
    expect(wrapper.findAll('button').some((button) => button.text() === 'Build index')).toBe(false)
    expect(wrapper.text()).toContain('Book Knowledge is turned off')
    expect(wrapper.text()).toContain('Turn on Book Knowledge in the AI settings')
    permissions.allowed = false
    const reader = panel()
    await flushPromises()
    expect(reader.text()).toContain('Book Knowledge is turned off')
    expect(reader.text()).not.toContain('Turn on Book Knowledge in the AI settings')
  })
  it('keeps Ask available while a card is still loading', async () => {
    mockReady({ ...ready, modelConfigured: true })
    const wrapper = panel()
    await flushPromises()
    vi.mocked(api).mockImplementation((url) => (String(url).includes('/card') ? new Promise<Response>(() => {}) : Promise.resolve(response(detail))))
    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('amber engine'))!
      .trigger('click')
    await flushPromises()
    await wrapper.get('textarea').setValue('What powers the amber engine?')
    const askButton = wrapper.findAll('button').find((button) => button.text() === 'Ask about this book')!
    expect(askButton.attributes('disabled')).toBeUndefined()
  })
  it('renders insufficient cards and not-in-book answers', async () => {
    mockReady({ ...ready, modelConfigured: true })
    const wrapper = panel()
    await flushPromises()
    vi.mocked(api).mockImplementation(async (url) => {
      if (String(url).includes('/ask'))
        return response({
          ...ready,
          answer: { answer: '', points: [], notInBook: true },
          checks: { meaningVerified: false, droppedPoints: 0, unknownPassage: false },
          passages: [],
          route: 'search',
        })
      if (String(url).includes('/card'))
        return response({
          ...ready,
          card: { meaning: '', meaningQuote: '', meaningPassage: 0, points: [], insufficient: true },
          checks: { meaningVerified: false, droppedPoints: 0, unknownPassage: false },
          passages: detail.passages,
        })
      return response(detail)
    })
    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('amber engine'))!
      .trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('There is not enough evidence')
    await wrapper.get('textarea').setValue('What powers the amber engine?')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.text()).toContain('No supporting answer was found')
    const init = vi.mocked(api).mock.calls.at(-1)?.[1]
    expect(JSON.parse(String(init?.body))).toEqual({ question: 'What powers the amber engine?' })
  })
})

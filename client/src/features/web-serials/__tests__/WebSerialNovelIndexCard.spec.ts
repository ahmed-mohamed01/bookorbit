import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { computed, reactive } from 'vue'
import type { WebSerialNovelIndexSource, WebSerialNovelIndexStatus } from '@bookorbit/types'
import { i18n } from '@/i18n'

const api = vi.hoisted(() => ({
  fetchNovelIndexStatus: vi.fn<() => Promise<WebSerialNovelIndexStatus>>(),
  runNovelIndexAction: vi.fn<(id: string, action: string) => Promise<WebSerialNovelIndexStatus>>(),
}))
const context = vi.hoisted(() => ({ draft: null as unknown as { novel: { indexDailyBudget: number } } }))

vi.mock('../api/webSerials', () => api)
vi.mock('../components/settings/settingsContext', () => ({
  useWebSerialSettingsContext: () => ({
    draft: context.draft,
    indexBudgetInvalid: computed(() => context.draft.novel.indexDailyBudget < 10),
  }),
}))

import WebSerialNovelIndexCard from '../components/settings/WebSerialNovelIndexCard.vue'

function source(overrides: Partial<WebSerialNovelIndexSource> = {}): WebSerialNovelIndexSource {
  return {
    sourceId: 'novelbuddy',
    name: 'NovelBuddy',
    enabled: true,
    fillState: 'filling',
    nextPage: 12,
    entries: 264,
    filledAt: null,
    lastTopupAt: null,
    lastError: null,
    requestsToday: 11,
    running: false,
    ...overrides,
  }
}

function status(sources: WebSerialNovelIndexSource[]): WebSerialNovelIndexStatus {
  return { dailyBudget: 1500, sources, unavailable: false }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  context.draft = reactive({ novel: { indexDailyBudget: 1500 } })
})

afterEach(() => {
  vi.useRealTimers()
})

async function mountCard() {
  const wrapper = mount(WebSerialNovelIndexCard, { global: { plugins: [i18n], stubs: { ConfirmDialog: true } } })
  await flushPromises()
  return wrapper
}

describe('WebSerialNovelIndexCard', () => {
  it('lists each source with its fill state, titles, last top-up, requests today and last error', async () => {
    api.fetchNovelIndexStatus.mockResolvedValue(
      status([
        source(),
        source({
          sourceId: 'lib',
          name: 'LibRead',
          fillState: 'done',
          enabled: false,
          entries: 1,
          lastTopupAt: new Date().toISOString(),
          lastError: 'blocked',
        }),
      ]),
    )
    const wrapper = await mountCard()

    const rows = wrapper.findAll('[data-testid="novel-index-source"]')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.get('[data-testid="novel-index-state"]').text()).toBe('Filling')
    expect(rows[0]!.text()).toContain('264 titles')
    expect(rows[0]!.text()).toContain('11 of 1,500 pages today')
    expect(rows[0]!.text()).toContain('Not checked for new titles yet')
    expect(rows[1]!.get('[data-testid="novel-index-state"]').text()).toBe('Indexed')
    expect(rows[1]!.text()).toContain('1 title')
    expect(rows[1]!.text()).toContain('Checked for new titles')
    expect(rows[1]!.text()).toContain('Turned off')
    expect(rows[1]!.text()).toContain('blocked')
    expect(rows[1]!.findAll('button')[0]!.attributes('disabled')).toBeDefined()
  })

  it('fills and rebuilds a source and polls while one is being indexed', async () => {
    api.fetchNovelIndexStatus.mockResolvedValue(status([source()]))
    api.runNovelIndexAction.mockResolvedValue(status([source({ running: true })]))
    const wrapper = await mountCard()

    const [fill, rebuild] = wrapper.get('[data-testid="novel-index-source"]').findAll('button')
    await fill!.trigger('click')
    await flushPromises()
    expect(api.runNovelIndexAction).toHaveBeenCalledWith('novelbuddy', 'fill')
    expect(wrapper.get('[data-testid="novel-index-state"]').text()).toBe('Indexing now')

    api.fetchNovelIndexStatus.mockResolvedValue(status([source({ fillState: 'done' })]))
    await vi.advanceTimersByTimeAsync(5_000)
    await flushPromises()
    expect(api.fetchNovelIndexStatus).toHaveBeenCalledTimes(2)
    expect(wrapper.get('[data-testid="novel-index-state"]').text()).toBe('Indexed')

    await rebuild!.trigger('click')
    await flushPromises()
    expect(api.runNovelIndexAction).toHaveBeenLastCalledWith('novelbuddy', 'fill')
    const dialog = wrapper.findComponent({ name: 'ConfirmDialog' })
    expect(dialog.props('open')).toBe(true)
    expect(dialog.props('title')).toBe('Rebuild the NovelBuddy index?')
    expect(dialog.props('description')).toContain('drops the 264 titles indexed for NovelBuddy')
    dialog.vm.$emit('confirm')
    await flushPromises()
    expect(api.runNovelIndexAction).toHaveBeenLastCalledWith('novelbuddy', 'rebuild')
    expect(wrapper.findComponent({ name: 'ConfirmDialog' }).props('open')).toBe(false)
  })

  it('names the source in each row button for screen readers', async () => {
    api.fetchNovelIndexStatus.mockResolvedValue(status([source()]))
    const wrapper = await mountCard()

    const [fill, rebuild] = wrapper.get('[data-testid="novel-index-source"]').findAll('button')
    expect(fill!.attributes('aria-label')).toBe('Fill now: NovelBuddy')
    expect(rebuild!.attributes('aria-label')).toBe('Rebuild: NovelBuddy')
  })

  it('edits the daily budget in the page draft and flags a value out of range', async () => {
    api.fetchNovelIndexStatus.mockResolvedValue(status([]))
    const wrapper = await mountCard()
    expect(wrapper.text()).toContain('No light novel sources are installed yet.')

    const input = wrapper.get('#web-serials-index-budget')
    await input.setValue('5')
    expect(context.draft.novel.indexDailyBudget).toBe(5)
    expect(input.attributes('aria-invalid')).toBe('true')
    await input.setValue('400')
    expect(context.draft.novel.indexDailyBudget).toBe(400)
  })

  it('shows the error when the status cannot be loaded', async () => {
    api.fetchNovelIndexStatus.mockRejectedValue(new Error('Could not load the light novel index.'))
    const wrapper = await mountCard()
    expect(wrapper.get('[role="alert"]').text()).toContain('Could not load the light novel index.')
  })
})

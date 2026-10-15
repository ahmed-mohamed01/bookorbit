import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import type { WebSerialMoveCandidate, WebSerialMoveCandidates } from '@bookorbit/types'
import { i18n } from '@/i18n'
import { job } from './fixtures'

const api = vi.hoisted(() => ({
  fetchMoveCandidates: vi.fn<(id: number) => Promise<WebSerialMoveCandidates>>(),
  moveSerialJob: vi.fn<(id: number, input: { seriesKey: string }) => Promise<unknown>>(),
}))

vi.mock('../api/webSerials', () => api)

import WebSerialMoveSheet from '../components/WebSerialMoveSheet.vue'

const passthrough = defineComponent({ template: '<div><slot /></div>' })
const stubs = { Sheet: passthrough, SheetContent: passthrough, SheetTitle: passthrough, SheetDescription: passthrough }

function candidate(overrides: Partial<WebSerialMoveCandidate> = {}): WebSerialMoveCandidate {
  return {
    seriesKey: 'm:20',
    title: 'Tower Climber',
    sourceName: 'AllManga',
    coverUrl: null,
    confidence: 'same_series',
    remainingAvailable: 7,
    remainingTotal: 7,
    ...overrides,
  }
}

function candidates(list: WebSerialMoveCandidate[], extra: Partial<WebSerialMoveCandidates> = {}): WebSerialMoveCandidates {
  return { remainingTotal: 7, candidates: list, failedSources: [], ...extra }
}

function mountSheet() {
  return mount(WebSerialMoveSheet, { props: { job: job({ id: 5, status: 'failed' }), open: true }, global: { plugins: [i18n], stubs } })
}

function buttonByText(wrapper: ReturnType<typeof mountSheet>, text: string) {
  return wrapper.findAll('button').find((button) => button.text() === text)
}

describe('WebSerialMoveSheet', () => {
  beforeEach(() => {
    Object.values(api).forEach((fn) => fn.mockReset())
  })

  it('shows the searching state while candidates load', async () => {
    api.fetchMoveCandidates.mockReturnValue(new Promise(() => {}))
    const wrapper = mountSheet()
    await flushPromises()
    expect(wrapper.text()).toContain('Searching your other sources...')
    expect(api.fetchMoveCandidates).toHaveBeenCalledWith(5, expect.anything())
  })

  it('renders candidates with confidence and availability, preselecting the first', async () => {
    api.fetchMoveCandidates.mockResolvedValue(
      candidates([candidate(), candidate({ seriesKey: 'm:30', sourceName: 'Other', confidence: 'title_match', remainingAvailable: 5 })]),
    )
    const wrapper = mountSheet()
    await flushPromises()
    const text = wrapper.text()
    expect(text).toContain('7 chapters left to download')
    expect(text).toContain('Same series')
    expect(text).toContain('Title match')
    expect(text).toContain('Has 7 of 7 remaining chapters')
    expect(text).toContain('Has 5 of 7: 2 will stay failed')
    const radios = wrapper.findAll('[role="radio"]')
    expect(radios.map((radio) => radio.attributes('aria-checked'))).toEqual(['true', 'false'])
    expect(buttonByText(wrapper, 'Move 7 chapters')).toBeDefined()
  })

  it('moves the chosen candidate and emits the result', async () => {
    const moved = { from: job({ id: 5 }), to: job({ id: 6, sourceName: 'Other' }) }
    api.fetchMoveCandidates.mockResolvedValue(
      candidates([candidate(), candidate({ seriesKey: 'm:30', sourceName: 'Other', remainingAvailable: 5, confidence: 'title_match' })]),
    )
    api.moveSerialJob.mockResolvedValue(moved)
    const wrapper = mountSheet()
    await flushPromises()
    await wrapper.findAll('[role="radio"]')[1]?.trigger('click')
    await buttonByText(wrapper, 'Move 5 chapters')?.trigger('click')
    await flushPromises()
    expect(api.moveSerialJob).toHaveBeenCalledWith(5, { seriesKey: 'm:30' })
    expect(wrapper.emitted('moved')?.[0]).toEqual([moved])
  })

  it('shows a server error inline and keeps the dialog open', async () => {
    api.fetchMoveCandidates.mockResolvedValue(candidates([candidate()]))
    api.moveSerialJob.mockRejectedValue(new Error('The download is busy; try again in a moment.'))
    const wrapper = mountSheet()
    await flushPromises()
    await buttonByText(wrapper, 'Move 7 chapters')?.trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('The download is busy')
    expect(wrapper.emitted('moved')).toBeUndefined()
  })

  it('shows the empty state and the sources that could not be searched', async () => {
    api.fetchMoveCandidates.mockResolvedValue(candidates([], { failedSources: ['AllManga'] }))
    const wrapper = mountSheet()
    await flushPromises()
    expect(wrapper.text()).toContain('No other source has this series.')
    expect(wrapper.text()).toContain('Could not search: AllManga')
    expect(buttonByText(wrapper, 'Move 0 chapters')?.attributes('disabled')).toBeDefined()
  })

  it('shows a load failure with a retry', async () => {
    api.fetchMoveCandidates.mockRejectedValueOnce(new Error('Nothing left to move.'))
    const wrapper = mountSheet()
    await flushPromises()
    expect(wrapper.text()).toContain('Nothing left to move.')
    api.fetchMoveCandidates.mockResolvedValue(candidates([candidate()]))
    await buttonByText(wrapper, 'Retry')?.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Same series')
  })
  it('moves the chosen source with the arrow keys', async () => {
    api.fetchMoveCandidates.mockResolvedValue(
      candidates([candidate(), candidate({ seriesKey: 'm:30', sourceName: 'Other', confidence: 'title_match' })]),
    )
    const wrapper = mount(WebSerialMoveSheet, {
      props: { job: job({ id: 5 }), open: true },
      global: { plugins: [i18n], stubs },
      attachTo: document.body,
    })
    await flushPromises()
    const radios = wrapper.findAll('[role="radio"]')
    expect(radios.map((radio) => radio.attributes('tabindex'))).toEqual(['0', '-1'])
    ;(radios[0]!.element as HTMLElement).focus()
    await radios[0]!.trigger('keydown', { key: 'ArrowDown' })
    await flushPromises()
    expect(wrapper.findAll('[role="radio"]').map((radio) => radio.attributes('aria-checked'))).toEqual(['false', 'true'])
    expect(document.activeElement).toBe(radios[1]!.element)
    wrapper.unmount()
  })
})

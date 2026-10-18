import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { MonitoredWork, BookSearchOption } from '@bookorbit/types'
import { searchLibraryBooks } from '../api/monitored'
import MonitoredMatchFilePicker from './MonitoredMatchFilePicker.vue'

vi.mock('../api/monitored', () => ({ LIBRARY_SEARCH_LIMIT: 20, searchLibraryBooks: vi.fn<() => Promise<BookSearchOption[]>>() }))
const searchMock = vi.mocked(searchLibraryBooks)

const passthrough = { template: '<div><slot /></div>' }
const popoverStub = { name: 'Popover', emits: ['update:open'], template: '<div><slot /></div>' }
const work = { id: 'work-1', title: 'Shadows of Self' } as MonitoredWork

describe('MonitoredMatchFilePicker', () => {
  it('starts from the work title and links the book the owner picks', async () => {
    vi.useFakeTimers()
    searchMock.mockResolvedValue([
      { id: 174, title: 'Shadows of Self', authors: ['Brandon Sanderson'], seriesName: null, libraryName: 'Books', formats: ['epub'] },
    ])
    const wrapper = mount(MonitoredMatchFilePicker, {
      props: { work, format: 'ebook', saving: false },
      global: { stubs: { Popover: popoverStub, PopoverTrigger: passthrough, PopoverContent: passthrough } },
    })

    wrapper.findComponent(popoverStub).vm.$emit('update:open', true)
    await vi.advanceTimersByTimeAsync(300)
    await flushPromises()

    expect(searchMock).toHaveBeenCalledWith('Shadows of Self', expect.anything())
    const result = wrapper.get('[data-testid="match-file-result"]')
    expect(result.text()).toContain('Brandon Sanderson · Books')
    await result.trigger('click')
    expect(wrapper.emitted('answer')).toEqual([['ebook', { decision: 'link', bookId: 174 }]])
    vi.useRealTimers()
  })

  it('fixes a match: leaves the current book out, and offers to drop the match', async () => {
    vi.useFakeTimers()
    const option = (id: number) => ({ id, title: `Book ${id}`, authors: [], seriesName: null, libraryName: 'Books', formats: ['epub'] })
    searchMock.mockResolvedValue([option(5), option(9)])
    const mountFix = (linkedByHand: boolean) =>
      mount(MonitoredMatchFilePicker, {
        props: { work, format: 'ebook', saving: false, currentBookId: 5, linkedByHand },
        global: { stubs: { Popover: popoverStub, PopoverTrigger: passthrough, PopoverContent: passthrough } },
      })

    const automatic = mountFix(false)
    expect(automatic.get('[data-testid="fix-match"]').text()).toBe('Fix match')
    automatic.findComponent(popoverStub).vm.$emit('update:open', true)
    await vi.advanceTimersByTimeAsync(300)
    await flushPromises()
    expect(automatic.findAll('[data-testid="match-file-result"]').map((row) => row.text())).toEqual(['Book 9Books'])
    await automatic.get('[data-testid="match-file-drop"]').trigger('click')
    expect(automatic.emitted('answer')).toEqual([['ebook', { decision: 'reject', bookId: 5 }]])

    const byHand = mountFix(true)
    await byHand.get('[data-testid="match-file-drop"]').trigger('click')
    expect(byHand.emitted('answer')).toEqual([['ebook', { decision: 'automatic' }]])
    vi.useRealTimers()
  })
})

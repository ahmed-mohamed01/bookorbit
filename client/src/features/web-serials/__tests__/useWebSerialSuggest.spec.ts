import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'

const api = vi.hoisted(() => ({ suggestSerials: vi.fn<(query: string, signal?: AbortSignal) => Promise<unknown>>() }))
vi.mock('../api/webSerials', () => api)

import { SUGGEST_DEBOUNCE_MS, useWebSerialSuggest } from '../composables/useWebSerialSuggest'
import { suggestion } from './fixtures'

function setup(enabled = true) {
  const query = ref('')
  const on = ref(enabled)
  const scope = effectScope()
  const suggest = scope.run(() => useWebSerialSuggest(query, on))!
  return { query, on, suggest, scope }
}

beforeEach(() => {
  vi.useFakeTimers()
  api.suggestSerials.mockReset()
  api.suggestSerials.mockResolvedValue({ query: 'om', suggestions: [suggestion(), suggestion({ title: 'Omega', entries: [] })] })
})

afterEach(() => {
  vi.useRealTimers()
})

async function settle() {
  await nextTick()
  await vi.advanceTimersByTimeAsync(SUGGEST_DEBOUNCE_MS)
  await Promise.resolve()
  await Promise.resolve()
}

describe('useWebSerialSuggest', () => {
  it('waits for a pause in typing and asks once for the latest text', async () => {
    const { query, suggest } = setup()
    query.value = 'om'
    await nextTick()
    await vi.advanceTimersByTimeAsync(100)
    query.value = 'omn'
    await settle()

    expect(api.suggestSerials).toHaveBeenCalledTimes(1)
    expect(api.suggestSerials.mock.calls[0]![0]).toBe('omn')
    expect(suggest.visible.value).toBe(true)
    expect(suggest.suggestions.value).toHaveLength(2)
  })

  it('asks nothing under two characters, for a link, or while disabled', async () => {
    const { query, on } = setup()
    query.value = 'o'
    await settle()
    query.value = 'https://novelbuddy.me/novel/x'
    await settle()
    on.value = false
    query.value = 'omni'
    await settle()
    expect(api.suggestSerials).not.toHaveBeenCalled()
  })

  it('aborts the previous request when the text changes again', async () => {
    let first: AbortSignal | undefined
    api.suggestSerials.mockImplementationOnce((_q, signal) => {
      first = signal
      return new Promise(() => undefined)
    })
    const { query } = setup()
    query.value = 'om'
    await settle()
    query.value = 'omni'
    await settle()
    expect(first?.aborted).toBe(true)
  })

  it('moves the highlight with wrap-around, closes, and stays closed for a chosen title', async () => {
    const { query, suggest } = setup()
    query.value = 'om'
    await settle()

    suggest.move(1)
    expect(suggest.highlighted.value).toBe(0)
    suggest.move(1)
    suggest.move(1)
    expect(suggest.highlighted.value).toBe(0)
    suggest.move(-1)
    expect(suggest.active.value?.title).toBe('Omega')
    suggest.close()
    expect(suggest.visible.value).toBe(false)

    suggest.settle('Omniscient Reader')
    query.value = 'Omniscient Reader'
    await settle()
    expect(api.suggestSerials).toHaveBeenCalledTimes(1)
    expect(suggest.suggestions.value).toEqual([])
  })

  it('shows nothing when the request fails', async () => {
    api.suggestSerials.mockRejectedValue(new Error('down'))
    const { query, suggest } = setup()
    query.value = 'om'
    await settle()
    expect(suggest.visible.value).toBe(false)
  })
})

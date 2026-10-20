import { afterEach, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import type { MonitoredFetchErrorKind } from '@bookorbit/types'
import en from '@/locales/en.json'
import { compileIcuCatalog } from '@/i18n/icu'
import MonitoredFetchFailedBanner from '../MonitoredFetchFailedBanner.vue'
const wrappers: ReturnType<typeof mount>[] = []
function setup(kind: MonitoredFetchErrorKind = 'timeout', retryAt: string | null = null) {
  const wrapper = mount(MonitoredFetchFailedBanner, {
    props: { status: { state: 'failed', errorKind: kind, errorAt: '2026-10-20T12:00:00Z', retryAt }, hasCatalog: false, lastRefreshedAt: null },
    global: { plugins: [createI18n({ legacy: false, locale: 'en', messages: { en: compileIcuCatalog(en, 'en') } })] },
  })
  wrappers.push(wrapper)
  return wrapper
}
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  vi.useRealTimers()
})
it.each(['timeout', 'rate_limited', 'unavailable', 'auth_failed', 'author_gone', 'not_configured'] as const)('shows %s copy', (kind) => {
  expect(setup(kind).text()).toContain(en.monitored.fetch[kind])
})
it('hides Retry for a missing author and emits retry otherwise', async () => {
  expect(setup('author_gone').find('button').exists()).toBe(false)
  const wrapper = setup()
  await wrapper.get('button').trigger('click')
  expect(wrapper.emitted('retry')).toEqual([[]])
})
it('updates the retry countdown every 30 seconds and clears its timer', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-20T12:00:00Z'))
  const wrapper = setup('timeout', '2026-10-20T12:04:10Z')
  expect(wrapper.text()).toContain('Retrying in 5 min')
  await vi.advanceTimersByTimeAsync(30_000)
  expect(wrapper.text()).toContain('Retrying in 4 min')
  wrapper.unmount()
  expect(vi.getTimerCount()).toBe(0)
})

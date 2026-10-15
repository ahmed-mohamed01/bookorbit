import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'
import WebSerialLookupCard from '../components/settings/WebSerialLookupCard.vue'

const OK = { ok: true, checkedAt: new Date().toISOString(), error: null, pausedUntil: null }

function mountCard(props: Partial<InstanceType<typeof WebSerialLookupCard>['$props']> = {}) {
  return mount(WebSerialLookupCard, {
    props: { enabled: true, health: null, testing: false, testError: null, ...props },
    global: { plugins: [i18n] },
  })
}

describe('WebSerialLookupCard', () => {
  it('reports a working lookup with its last check time', () => {
    const wrapper = mountCard({ health: OK })
    expect(wrapper.get('[data-testid="lookup-status"]').text()).toBe('Working')
    expect(wrapper.text()).toContain('checked')
    expect(wrapper.text()).toContain('Looks up each manga and light novel in MangaBaka')
  })

  it('shows the failure reason', () => {
    const wrapper = mountCard({ health: { ...OK, ok: false, error: 'MangaBaka returned 503' } })
    expect(wrapper.get('[data-testid="lookup-status"]').text()).toBe('Failing')
    expect(wrapper.get('[role="alert"]').text()).toContain('MangaBaka returned 503')
  })

  it('shows when lookups are paused', () => {
    const pausedUntil = new Date(Date.now() + 5 * 60_000).toISOString()
    const wrapper = mountCard({ health: { ...OK, ok: false, error: 'timed out', pausedUntil } })
    expect(wrapper.get('[data-testid="lookup-status"]').text()).toContain('Paused until')
  })

  it('explains what lookups do, send and risk behind a disclosure', async () => {
    const wrapper = mountCard({ health: OK })
    expect(wrapper.find('dl').exists()).toBe(false)
    const toggle = wrapper.get('[aria-controls="web-serials-lookup-explained"]')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    await toggle.trigger('click')
    expect(toggle.attributes('aria-expanded')).toBe('true')
    const text = wrapper.get('dl').text()
    expect(text).toContain('MangaDex')
    expect(text).toContain('Only the series title and author')
    expect(text).toContain('Downloads never stop')
  })

  it('explains the 5 minute pause while paused', () => {
    const pausedUntil = new Date(Date.now() + 5 * 60_000).toISOString()
    const wrapper = mountCard({ health: { ...OK, ok: false, error: 'timed out', pausedUntil } })
    expect(wrapper.get('[role="alert"]').text()).toContain('5 minutes')
  })

  it('emits test and toggle changes', async () => {
    const wrapper = mountCard({ health: OK })
    await wrapper
      .findAll('button')
      .find((candidate) => candidate.text() === 'Test')
      ?.trigger('click')
    expect(wrapper.emitted('test')).toHaveLength(1)
    await wrapper.get('[role="switch"]').trigger('click')
    expect(wrapper.emitted('update:enabled')?.[0]).toEqual([false])
  })

  it('shows Off and disables Test when switched off', () => {
    const wrapper = mountCard({ enabled: false, health: OK })
    expect(wrapper.get('[data-testid="lookup-status"]').text()).toBe('Off')
    expect(
      wrapper
        .findAll('button')
        .find((candidate) => candidate.text() === 'Test')
        ?.attributes('disabled'),
    ).toBeDefined()
  })
})

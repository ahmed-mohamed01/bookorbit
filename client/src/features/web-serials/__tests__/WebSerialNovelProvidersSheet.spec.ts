import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import type { WebSerialNovelProviders } from '@bookorbit/types'
import { i18n } from '@/i18n'

const api = vi.hoisted(() => ({
  fetchNovelProviders: vi.fn<() => Promise<WebSerialNovelProviders>>(),
  saveNovelProviders: vi.fn<(input: { disabledDomains: string[] }) => Promise<WebSerialNovelProviders>>(),
}))

vi.mock('../api/webSerials', () => api)
vi.mock('vue-sonner', () => ({ toast: { error: vi.fn<() => void>() } }))

import WebSerialNovelProvidersSheet from '../components/WebSerialNovelProvidersSheet.vue'

const passthrough = defineComponent({ template: '<div><slot /></div>' })
const stubs = { Sheet: passthrough, SheetContent: passthrough, SheetTitle: passthrough, SheetDescription: passthrough }

const PROVIDERS: WebSerialNovelProviders = {
  search: [{ domain: 'royalroad.com', name: 'Royal Road', enabled: true }],
  linkSites: [
    { domain: 'royalroad.com', name: 'Royal Road' },
    { domain: 'webnovel.com', name: 'Webnovel' },
  ],
  linkSitesTotal: 338,
  unavailable: false,
}

async function mountSheet(providers: WebSerialNovelProviders = PROVIDERS) {
  api.fetchNovelProviders.mockResolvedValue(providers)
  const wrapper = mount(WebSerialNovelProvidersSheet, { props: { open: true }, global: { plugins: [i18n], stubs } })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('WebSerialNovelProvidersSheet', () => {
  it('lists the admin-enabled sites with a toggle that saves', async () => {
    api.saveNovelProviders.mockResolvedValue({ ...PROVIDERS, search: [{ domain: 'royalroad.com', name: 'Royal Road', enabled: false }] })
    const wrapper = await mountSheet()
    expect(wrapper.text()).toContain('Royal Road')
    await wrapper.get('[role="switch"]').trigger('click')
    expect(api.saveNovelProviders).toHaveBeenCalledWith({ disabledDomains: ['royalroad.com'] })
  })

  it('shows a site once when the engine gives no name beyond its domain', async () => {
    const wrapper = await mountSheet({
      ...PROVIDERS,
      search: [{ domain: 'novelbuddy.com', name: 'novelbuddy.com', enabled: true }],
    })
    expect(wrapper.text().match(/novelbuddy\.com/g)).toHaveLength(1)
  })

  it('keeps the link list collapsed, then opens and filters it', async () => {
    const wrapper = await mountSheet()
    expect(wrapper.text()).toContain('338')
    expect(wrapper.find('input[type="search"]').exists()).toBe(false)
    await wrapper.get('[aria-controls="web-serials-providers-links-body"]').trigger('click')
    await wrapper.get('input[type="search"]').setValue('webn')
    const rows = wrapper.findAll('#web-serials-providers-links-body li')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.text()).toContain('webnovel.com')
  })

  it('says so when the engine is unavailable', async () => {
    const wrapper = await mountSheet({ ...PROVIDERS, linkSites: [], linkSitesTotal: 0, unavailable: true })
    await wrapper.get('[aria-controls="web-serials-providers-links-body"]').trigger('click')
    expect(wrapper.text()).toContain('could not be loaded right now')
    expect(wrapper.find('input[type="search"]').exists()).toBe(false)
  })

  it('offers a retry when loading fails', async () => {
    api.fetchNovelProviders.mockRejectedValueOnce(new Error('boom'))
    const wrapper = mount(WebSerialNovelProvidersSheet, { props: { open: true }, global: { plugins: [i18n], stubs } })
    await flushPromises()
    expect(wrapper.text()).toContain('boom')
    api.fetchNovelProviders.mockResolvedValueOnce(PROVIDERS)
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Retry')
      ?.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Royal Road')
  })
})

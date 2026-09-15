import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { apiMock, toastErrorMock, toastSuccessMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
  toastErrorMock: vi.fn<(message: string) => void>(),
  toastSuccessMock: vi.fn<(message: string) => void>(),
}))

vi.mock('@/lib/api', () => ({ api: apiMock }))
vi.mock('vue-sonner', () => ({
  toast: { error: toastErrorMock, success: toastSuccessMock },
}))

import MonitoredSettings from '../MonitoredSettings.vue'

function response(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 400,
    json: vi.fn<() => Promise<unknown>>().mockResolvedValue(body),
  } as unknown as Response
}

async function mountSettings() {
  const wrapper = mount(MonitoredSettings, { props: { embedded: true } })
  await flushPromises()
  return wrapper
}

describe('MonitoredSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMock.mockImplementation(async (_url, init) => {
      if (init?.method === 'PUT') return response(JSON.parse(String(init.body)))
      return response({ refreshCooldownMinutes: 10, syncEnabled: true, syncIntervalHours: 12 })
    })
  })

  it('loads the current server setting', async () => {
    const wrapper = await mountSettings()

    expect(apiMock).toHaveBeenCalledWith('/api/v1/monitored/settings')
    const inputs = wrapper.findAll('input[type="number"]')
    expect((inputs[0].element as HTMLInputElement).value).toBe('10')
    expect((inputs[1].element as HTMLInputElement).value).toBe('12')
  })

  it('saves the cooldown and the sync settings together through the protected endpoint', async () => {
    const wrapper = await mountSettings()
    const inputs = wrapper.findAll('input[type="number"]')
    await inputs[0].setValue('30')
    await inputs[1].setValue('24')
    await wrapper.get('button:not([role="switch"])').trigger('click')
    await flushPromises()

    expect(apiMock).toHaveBeenLastCalledWith('/api/v1/monitored/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshCooldownMinutes: 30, syncEnabled: true, syncIntervalHours: 24 }),
    })
    expect(toastSuccessMock).toHaveBeenCalledOnce()
  })

  it('rejects a sync interval outside the supported range before making a request', async () => {
    const wrapper = await mountSettings()
    await wrapper.findAll('input[type="number"]')[1].setValue('0')
    await wrapper.get('button:not([role="switch"])').trigger('click')

    expect(apiMock).toHaveBeenCalledTimes(1)
    expect(toastErrorMock).toHaveBeenCalledOnce()
  })

  it('rejects values outside the supported range before making a request', async () => {
    const wrapper = await mountSettings()
    await wrapper.findAll('input[type="number"]')[0].setValue('0')
    await wrapper.get('button:not([role="switch"])').trigger('click')

    expect(apiMock).toHaveBeenCalledTimes(1)
    expect(toastErrorMock).toHaveBeenCalledOnce()
  })
})

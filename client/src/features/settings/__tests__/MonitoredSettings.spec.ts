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
      return response({ refreshCooldownMinutes: 10 })
    })
  })

  it('loads the current server setting', async () => {
    const wrapper = await mountSettings()

    expect(apiMock).toHaveBeenCalledWith('/api/v1/app-settings/monitored')
    expect((wrapper.get('input[type="number"]').element as HTMLInputElement).value).toBe('10')
  })

  it('saves a typed cooldown through the protected endpoint', async () => {
    const wrapper = await mountSettings()
    await wrapper.get('input[type="number"]').setValue('30')
    await wrapper.get('button').trigger('click')
    await flushPromises()

    expect(apiMock).toHaveBeenLastCalledWith('/api/v1/app-settings/monitored', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshCooldownMinutes: 30 }),
    })
    expect(toastSuccessMock).toHaveBeenCalledOnce()
  })

  it('rejects values outside the supported range before making a request', async () => {
    const wrapper = await mountSettings()
    await wrapper.get('input[type="number"]').setValue('0')
    await wrapper.get('button').trigger('click')

    expect(apiMock).toHaveBeenCalledTimes(1)
    expect(toastErrorMock).toHaveBeenCalledOnce()
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'

import * as api from '../../api/audio-convert'
import { resetAudioConvertEnabled, useAudioConvertEnabled } from '../useAudioConvertEnabled'

vi.mock('../../api/audio-convert', () => {
  class AudioConvertHttpError extends Error {
    constructor(readonly status: number) {
      super(`HTTP ${status}`)
    }
  }
  return { AudioConvertHttpError, fetchAudioConvertEnabled: vi.fn<(...args: unknown[]) => unknown>() }
})

const fetchEnabled = vi.mocked(api.fetchAudioConvertEnabled)

afterEach(() => {
  resetAudioConvertEnabled()
  vi.clearAllMocks()
})

describe('useAudioConvertEnabled', () => {
  it('keeps the flag and the saved encoder defaults from one shared request', async () => {
    fetchEnabled.mockResolvedValue({ enabled: true, encoder: { codec: 'aac', bitrate: '64k', channels: 1 } })
    const first = useAudioConvertEnabled({ autoload: false })
    await first.load()
    const second = useAudioConvertEnabled()

    expect(second.enabled.value).toBe(true)
    expect(second.encoder.value).toEqual({ codec: 'aac', bitrate: '64k', channels: 1 })
    expect(fetchEnabled).toHaveBeenCalledTimes(1)
  })

  it('reads a 404 (no fork module) as off and does not ask again', async () => {
    fetchEnabled.mockRejectedValue(new api.AudioConvertHttpError(404))
    const { enabled, load } = useAudioConvertEnabled({ autoload: false })
    await load()
    expect(enabled.value).toBe(false)

    await load()
    expect(fetchEnabled).toHaveBeenCalledTimes(1)
  })

  it('leaves any other failure unknown and retries on the next use', async () => {
    fetchEnabled.mockRejectedValueOnce(new api.AudioConvertHttpError(503)).mockRejectedValueOnce(new TypeError('offline'))
    fetchEnabled.mockResolvedValueOnce({ enabled: true, encoder: { codec: 'auto', bitrate: '128k', channels: null } })
    const { enabled, load } = useAudioConvertEnabled({ autoload: false })

    await load()
    expect(enabled.value).toBeNull()
    await load()
    expect(enabled.value).toBeNull()
    await load()
    expect(enabled.value).toBe(true)
    expect(fetchEnabled).toHaveBeenCalledTimes(3)
  })

  it('takes a saved state from Settings without a request', () => {
    const { enabled, encoder, setState } = useAudioConvertEnabled({ autoload: false })
    setState(false, { codec: 'copy', bitrate: '96k', channels: 2 })

    expect(enabled.value).toBe(false)
    expect(encoder.value).toEqual({ codec: 'copy', bitrate: '96k', channels: 2 })
    expect(fetchEnabled).not.toHaveBeenCalled()
  })
})

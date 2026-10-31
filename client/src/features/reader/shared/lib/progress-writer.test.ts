import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<unknown>>())
vi.mock('@/lib/api', () => ({ api: apiMock }))

import { createNarrationProgressWriter } from './progress-writer'

function postedWrite(callIndex: number): Record<string, unknown> {
  const [, init] = apiMock.mock.calls[callIndex]!
  return (JSON.parse((init as RequestInit).body as string) as { writes: Record<string, unknown>[] }).writes[0]!
}

describe('createNarrationProgressWriter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    apiMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('saves narration over the loaded record so the text position survives', async () => {
    apiMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [{ fileId: 5, percentage: 42, updatedAt: null, text: { cfi: 'epubcfi(/6/2)', page: 7 } }] }),
    })
    apiMock.mockResolvedValue({ ok: true })
    const writer = createNarrationProgressWriter(5, true)

    await writer.load()
    writer.setMediaOverlayProgress('c1.xhtml#s3', 1)
    writer.flush()

    expect(apiMock).toHaveBeenCalledTimes(2)
    expect(apiMock.mock.calls[1]![0]).toBe('/api/v1/reading-progress')
    expect(postedWrite(1)).toMatchObject({
      fileId: 5,
      kind: 'narration',
      percentage: 42,
      text: { cfi: 'epubcfi(/6/2)', page: 7 },
      narration: { fragment: 'c1.xhtml#s3', sectionIndex: 1 },
    })
  })

  it('never reads or writes progress when tracking is off', async () => {
    const writer = createNarrationProgressWriter(5, false)

    await writer.load()
    writer.setMediaOverlayProgress('c1.xhtml#s3', 1)
    writer.flush()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(apiMock).not.toHaveBeenCalled()
  })

  it('saves once per interval while narration keeps moving', async () => {
    apiMock.mockResolvedValue({ ok: true })
    const writer = createNarrationProgressWriter(5, true)

    writer.setMediaOverlayProgress('c1.xhtml#s1', 1)
    writer.setMediaOverlayProgress('c1.xhtml#s2', 1)
    writer.setMediaOverlayProgress('c1.xhtml#s3', 1)
    await vi.advanceTimersByTimeAsync(15_000)

    expect(apiMock).toHaveBeenCalledTimes(1)
    expect(postedWrite(0).narration).toMatchObject({ fragment: 'c1.xhtml#s3' })
  })
})

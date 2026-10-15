import { beforeEach, describe, expect, it, vi } from 'vitest'
import { i18n } from '@/i18n'
import {
  fetchSeries,
  pauseSerialJob,
  resolveSerialUrl,
  runNovelIndexAction,
  searchSerials,
  suggestSerials,
  fetchNovelIndexStatus,
} from '../api/webSerials'
import { messageOf } from '../lib/messageOf'

const http = vi.hoisted(() => ({ api: vi.fn<(input: unknown, init?: unknown) => Promise<Response>>() }))

vi.mock('@/lib/api', () => http)

function failed(body: unknown, status = 400): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

beforeEach(() => {
  http.api.mockReset()
})

describe('web serials api errors', () => {
  it('shows the translated text for a code the catalog covers, not the server English', async () => {
    http.api.mockResolvedValue(failed({ message: 'server english', errorCode: 'WEB_SERIAL_LINKS_NOVEL_ONLY' }))

    await expect(resolveSerialUrl({ url: 'https://x/y' })).rejects.toMatchObject({
      message: i18n.global.t('errors.codes.WEB_SERIAL_LINKS_NOVEL_ONLY'),
      status: 400,
    })
  })

  it('shows the text of a coded server error, with the details it carries filled in', async () => {
    http.api.mockResolvedValueOnce(
      failed({ message: 'Only waiting or running downloads can be paused', errorCode: 'WEB_SERIAL_JOB_PAUSE_NOT_ALLOWED' }, 409),
    )
    const refused = await pauseSerialJob(4).catch((error: unknown) => error)
    expect(messageOf(refused, 'webSerials.api.pauseJob')).toBe('Only waiting or running downloads can be paused.')

    http.api.mockResolvedValueOnce(
      failed({ message: 'Cloudflare blocked the request', errorCode: 'WEB_SERIAL_SOURCE_FAILED', errorMeta: { source: 'NovelBin' } }, 502),
    )
    await expect(fetchSeries('nl:a:b')).rejects.toMatchObject({
      message: 'NovelBin could not complete the request. Try again later, or pick another source.',
      errorCode: 'WEB_SERIAL_SOURCE_FAILED',
      serverMessage: 'Cloudflare blocked the request',
      status: 502,
    })
  })

  it('passes the abort signal to the resolve request', async () => {
    http.api.mockResolvedValue(new Response(JSON.stringify({ seriesKey: 'n:1' }), { status: 200 }))
    const controller = new AbortController()

    await resolveSerialUrl({ url: 'https://x/y' }, controller.signal)

    expect(http.api).toHaveBeenCalledWith(expect.stringContaining('/resolve'), expect.objectContaining({ method: 'POST', signal: controller.signal }))
  })

  it('names the action that failed when the code is unknown, keeping the server English only for logs', async () => {
    http.api.mockResolvedValue(failed({ message: 'Library not found', errorCode: 'SOMETHING_ELSE' }))

    await expect(resolveSerialUrl({ url: 'https://x/y' })).rejects.toMatchObject({
      message: i18n.global.t('webSerials.api.resolve'),
      serverMessage: 'Library not found',
      status: 400,
    })
  })

  it('translates every fallback the api layer uses', async () => {
    const api = await import('../api/webSerials')
    http.api.mockImplementation(() => Promise.resolve(failed({}, 500)))

    const failures = await Promise.allSettled([
      api.fetchCapabilities(),
      api.fetchSerialJobs(),
      api.removeSerialJob(1),
      api.addMangaRepo({ url: 'x' }),
    ])

    for (const failure of failures) {
      expect(failure.status).toBe('rejected')
      const message = (failure as PromiseRejectedResult).reason.message as string
      expect(message).not.toMatch(/^webSerials\./)
      expect(message.length).toBeGreaterThan(0)
    }
  })
})

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('light novel index requests', () => {
  it('asks for suggestions and the index phase with the documented query strings', async () => {
    http.api.mockImplementation(() => Promise.resolve(ok({ query: 'om', suggestions: [], hits: [], failedSources: [] })))

    await suggestSerials('om ni')
    await searchSerials('omni', 'novel', undefined, false, 'index')
    await searchSerials('omni', 'novel', undefined, true)

    expect(http.api.mock.calls.map((call) => call[0])).toEqual([
      '/api/v1/web-serials/suggest?q=om+ni&kind=novel',
      '/api/v1/web-serials/search?q=omni&kind=novel&phase=index',
      '/api/v1/web-serials/search?q=omni&kind=novel&refresh=1',
    ])
  })

  it('reads the admin index status and posts fill and rebuild per source', async () => {
    http.api.mockImplementation(() => Promise.resolve(ok({ dailyBudget: 1500, sources: [], unavailable: false })))

    await fetchNovelIndexStatus()
    await runNovelIndexAction('novel buddy', 'fill')
    await runNovelIndexAction('novel buddy', 'rebuild')

    expect(http.api.mock.calls).toEqual([
      ['/api/v1/web-serials/admin/novel-index', undefined],
      ['/api/v1/web-serials/admin/novel-index/novel%20buddy/fill', { method: 'POST' }],
      ['/api/v1/web-serials/admin/novel-index/novel%20buddy/rebuild', { method: 'POST' }],
    ])
  })
})

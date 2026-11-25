import { effectScope } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { useBookKnowledge } from './useBookKnowledge'
vi.mock('@/lib/api', () => ({ api: vi.fn<typeof import('@/lib/api').api>() }))
const status = {
  status: 'ready',
  scope: 'position',
  cutoffOrdinal: 12,
  noProgress: false,
  progress: 100,
  error: null,
  modelConfigured: false,
  enabled: true,
}
function response(data: unknown) {
  return new Response(JSON.stringify(data))
}
const scopes: ReturnType<typeof effectScope>[] = []
function setup() {
  const scope = effectScope()
  scopes.push(scope)
  return scope.run(() => useBookKnowledge(17))!
}
describe('Book Knowledge requests', () => {
  afterEach(() => {
    scopes.splice(0).forEach((scope) => scope.stop())
    vi.resetAllMocks()
    vi.useRealTimers()
  })
  it('ignores a late response from the previous scope even if transport ignores abort', async () => {
    let resolveOld!: (response: Response) => void
    let oldSignal: AbortSignal | null | undefined
    vi.mocked(api).mockImplementation((url, init) => {
      if (String(url).endsWith('scope=position')) {
        oldSignal = init?.signal
        return new Promise<Response>((resolve) => {
          resolveOld = resolve
        })
      }
      return Promise.resolve(response({ ...status, scope: 'full', status: 'none' }))
    })
    const knowledge = setup()
    knowledge.scope.value = 'full'
    await flushPromises()
    expect(oldSignal?.aborted).toBe(true)
    resolveOld(response(status))
    await flushPromises()
    expect(knowledge.status.value?.scope).toBe('full')
    expect(knowledge.terms.value).toEqual([])
  })
  it('pages terms in bounded requests and encodes a selected term key', async () => {
    vi.mocked(api).mockImplementation(async (url) => {
      if (String(url).includes('/terms?')) {
        const offset = Number(new URL(String(url), 'http://example.test').searchParams.get('offset'))
        return response({
          items: Array.from({ length: offset ? 1 : 50 }, (_, index) => ({
            key: `invented ${index + offset}`,
            aliases: [],
            type: 'concept',
            count: 1,
            first: 1,
            latest: 1,
            score: 1,
          })),
          total: 51,
          offset,
          limit: 50,
          scope: 'position',
          cutoffOrdinal: 12,
          noProgress: false,
        })
      }
      if (String(url).includes('/terms/')) return new Response('', { status: 404 })
      return response(status)
    })
    const knowledge = setup()
    await flushPromises()
    expect(knowledge.terms.value).toHaveLength(50)
    await knowledge.loadMore()
    expect(knowledge.terms.value).toHaveLength(51)
    expect(knowledge.hasMore.value).toBe(false)
    expect(api).toHaveBeenCalledWith(expect.stringContaining('limit=50&offset=50'), expect.anything())
    await knowledge.selectTerm('amber engine')
    expect(api).toHaveBeenLastCalledWith(expect.stringContaining('/terms/amber%20engine?scope=position'), expect.anything())
  })
  it.each(['stale', 'queued'] as const)('keeps polling while the index is %s', async (state) => {
    vi.useFakeTimers()
    vi.mocked(api).mockImplementation(async () => response({ ...status, status: state, enabled: true }))
    setup()
    await flushPromises()
    expect(api).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(api).toHaveBeenCalledTimes(2)
  })
  it('does not poll a stale index while Book Knowledge is turned off', async () => {
    vi.useFakeTimers()
    vi.mocked(api).mockImplementation(async () => response({ ...status, status: 'stale', enabled: false }))
    setup()
    await flushPromises()
    await vi.advanceTimersByTimeAsync(60000)
    expect(api).toHaveBeenCalledTimes(1)
  })
  it.each(['terms', 'detail', 'card', 'ask'] as const)('refetches status after a 409 from %s', async (channel) => {
    const ready = { ...status, modelConfigured: true }
    const paths = { terms: '/terms?', detail: '/terms/amber?', card: '/card', ask: '/ask' }
    const statusCalls = () => vi.mocked(api).mock.calls.filter(([url]) => /\/knowledge\?scope=/.test(String(url))).length
    vi.mocked(api).mockImplementation(async (url) => {
      const target = String(url)
      if (target.includes(paths[channel])) return new Response('', { status: 409 })
      if (target.includes('/card')) return response({ ...ready, card: {}, checks: {}, passages: [] })
      if (target.includes('/terms?')) return response({ items: [], total: 0 })
      if (target.includes('/terms/')) return response({ ...ready, term: { key: 'amber' }, passages: [] })
      return response(ready)
    })
    const knowledge = setup()
    await flushPromises()
    const before = statusCalls()
    if (channel === 'terms') await knowledge.loadMore()
    else if (channel === 'ask') await knowledge.ask('Who is Amber?')
    else await knowledge.selectTerm('amber')
    await flushPromises()
    expect(statusCalls()).toBe(before + 1)
    expect(knowledge.error.value).toBeNull()
  })
  it.each([
    [429, { errorCode: 'budget' }, 'budget'],
    [429, { errorCode: 'reader-cap' }, 'readerCap'],
    [429, { code: 'budget' }, 'busy'],
    [503, {}, 'busy'],
    [502, {}, 'request'],
  ] as const)('maps a %i %o model reply to the %s message', async (code, body, expected) => {
    vi.mocked(api).mockImplementation(async (url) =>
      String(url).includes('/ask') ? new Response(JSON.stringify(body), { status: code }) : response({ ...status, modelConfigured: true }),
    )
    const knowledge = setup()
    await flushPromises()
    await knowledge.ask('Who is Amber?')
    expect(knowledge.error.value).toBe(expected)
  })
  it('stops polling when the index becomes ready', async () => {
    vi.useFakeTimers()
    vi.mocked(api).mockImplementation(async () => response({ ...status, status: 'queued' }))
    const knowledge = setup()
    await flushPromises()
    vi.mocked(api).mockImplementation(async (url) => (String(url).includes('/terms?') ? response({ items: [], total: 0 }) : response(status)))
    await vi.advanceTimersByTimeAsync(1000)
    expect(knowledge.status.value?.status).toBe('ready')
    const count = vi.mocked(api).mock.calls.length
    await vi.advanceTimersByTimeAsync(60000)
    expect(api).toHaveBeenCalledTimes(count)
  })
})
it('retries terms after a ready status and failed first load', async () => {
  let calls = 0
  vi.mocked(api).mockImplementation(async (url) => {
    if (!String(url).includes('/terms?')) return response(status)
    calls++
    if (calls === 1) return new Response('', { status: 500 })
    return response({ items: [{ key: 'amber mesh' }], total: 1 })
  })
  const knowledge = setup()
  await flushPromises()
  expect(knowledge.error.value).toBe('request')
  await knowledge.refreshStatus()
  expect(calls).toBe(2)
  expect(knowledge.terms.value[0].key).toBe('amber mesh')
  expect(knowledge.error.value).toBeNull()
  scopes.splice(0).forEach((scope) => scope.stop())
  vi.resetAllMocks()
})

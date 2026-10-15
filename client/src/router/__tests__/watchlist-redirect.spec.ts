import { describe, expect, it } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { routes } from '@/router'

function buildRouter() {
  return createRouter({ history: createMemoryHistory(), routes })
}

describe('watchlist routes', () => {
  it('redirects /monitored to /watchlist and keeps the query', async () => {
    const router = buildRouter()
    await router.push('/monitored?q=1')
    expect(router.currentRoute.value.path).toBe('/watchlist')
    expect(router.currentRoute.value.query).toEqual({ q: '1' })
    expect(router.currentRoute.value.name).toBe('monitored')
  })

  it('redirects /monitored/authors/:id to /watchlist/authors/:id and keeps the query', async () => {
    const router = buildRouter()
    await router.push('/monitored/authors/abc?from=x')
    expect(router.currentRoute.value.path).toBe('/watchlist/authors/abc')
    expect(router.currentRoute.value.query).toEqual({ from: 'x' })
    expect(router.currentRoute.value.name).toBe('monitored-author')
  })
})

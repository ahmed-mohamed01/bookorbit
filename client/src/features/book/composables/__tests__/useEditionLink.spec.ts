import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'

const mocks = vi.hoisted(() => ({
  api: vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(),
}))

vi.mock('@/lib/api', () => ({
  api: mocks.api,
}))

import { getBookLinkModality } from '../useEditionLink'

function response(data: unknown, options: { ok?: boolean; status?: number } = {}): Response {
  const { ok = true, status = ok ? 200 : 500 } = options
  return {
    ok,
    status,
    json: async () => data,
  } as Response
}

const counterpartBook = { id: 20, title: 'Counterpart Title', authors: [{ name: 'Jane Author' }] }

describe('getBookLinkModality', () => {
  it('returns text when only text-format content files are present', () => {
    expect(getBookLinkModality([{ format: 'epub', role: 'content' }])).toBe('text')
  })

  it('returns audio when only audio-format content files are present', () => {
    expect(getBookLinkModality([{ format: 'm4b', role: 'content' }])).toBe('audio')
  })

  it('returns both when text and audio content files coexist', () => {
    expect(
      getBookLinkModality([
        { format: 'epub', role: 'content' },
        { format: 'mp3', role: 'content' },
      ]),
    ).toBe('both')
  })

  it('returns none for no files or non-content roles', () => {
    expect(getBookLinkModality([])).toBe('none')
    expect(getBookLinkModality([{ format: 'epub', role: 'cover' }])).toBe('none')
    expect(getBookLinkModality([{ format: null, role: 'content' }])).toBe('none')
  })

  it('counts a "primary"-role file - a single-file book\'s content arrives as primary from the detail API', () => {
    expect(getBookLinkModality([{ format: 'm4b', role: 'primary' }])).toBe('audio')
    expect(getBookLinkModality([{ format: 'epub', role: 'primary' }])).toBe('text')
  })
})

describe('useEditionLink', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.api.mockReset()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function load(bookId: number) {
    const mod = await import('../useEditionLink')
    return mod.useEditionLink(bookId)
  }

  describe('loadForBook', () => {
    it('loads an existing link and enriches it with the counterpart summary', async () => {
      const editionLink = { id: 1, textBookId: 10, audioBookId: 20, createdBy: 1, createdAt: '2026-01-01T00:00:00.000Z' }
      mocks.api.mockResolvedValueOnce(response({ link: editionLink, proposed: null }))
      mocks.api.mockResolvedValueOnce(response(counterpartBook))

      const { link, proposed, linkedCounterpart, loading, error, loadForBook } = await load(10)
      await loadForBook()

      expect(mocks.api).toHaveBeenNthCalledWith(1, '/api/v1/edition-links/for-book/10')
      expect(mocks.api).toHaveBeenNthCalledWith(2, '/api/v1/books/20')
      expect(link.value).toEqual(editionLink)
      expect(proposed.value).toBeNull()
      expect(linkedCounterpart.value).toEqual({ bookId: 20, title: 'Counterpart Title', authorName: 'Jane Author', score: 100 })
      expect(loading.value).toBe(false)
      expect(error.value).toBeNull()
    })

    it('loads a proposed candidate without fetching a counterpart summary', async () => {
      const proposedCandidate = { bookId: 30, title: 'Maybe This One', authorName: 'Some Author', score: 82 }
      mocks.api.mockResolvedValueOnce(response({ link: null, proposed: proposedCandidate }))

      const { link, proposed, linkedCounterpart, loadForBook } = await load(10)
      await loadForBook()

      expect(mocks.api).toHaveBeenCalledOnce()
      expect(link.value).toBeNull()
      expect(proposed.value).toEqual(proposedCandidate)
      expect(linkedCounterpart.value).toBeNull()
    })

    it('degrades safely when the request fails without throwing', async () => {
      mocks.api.mockResolvedValueOnce(response(null, { ok: false, status: 500 }))

      const { link, proposed, loading, error, loadForBook } = await load(10)
      await expect(loadForBook()).resolves.toBeUndefined()

      expect(link.value).toBeNull()
      expect(proposed.value).toBeNull()
      expect(loading.value).toBe(false)
      expect(error.value).toBe('Failed to load edition link')
    })

    it('degrades safely on a network exception without throwing', async () => {
      mocks.api.mockRejectedValueOnce(new Error('network down'))

      const { loading, error, loadForBook } = await load(10)
      await expect(loadForBook()).resolves.toBeUndefined()

      expect(loading.value).toBe(false)
      expect(error.value).toBe('Failed to load edition link')
    })
  })

  describe('searchCandidates', () => {
    it('debounces the request by 250ms and coalesces rapid calls into one fetch', async () => {
      mocks.api.mockResolvedValue(response([{ bookId: 1, title: 'Found', authorName: 'Author', score: 90 }]))

      const { candidates, searching, searchCandidates } = await load(10)
      const first = searchCandidates('ha')
      await vi.advanceTimersByTimeAsync(100)
      const second = searchCandidates('harry')
      expect(searching.value).toBe(true)

      await vi.advanceTimersByTimeAsync(250)
      await Promise.all([first, second])

      expect(mocks.api).toHaveBeenCalledExactlyOnceWith('/api/v1/edition-links/candidates/10?q=harry')
      expect(candidates.value).toEqual([{ bookId: 1, title: 'Found', authorName: 'Author', score: 90 }])
      expect(searching.value).toBe(false)
    })

    it('omits the q param for an empty query', async () => {
      mocks.api.mockResolvedValueOnce(response([]))
      const { searchCandidates } = await load(10)

      const pending = searchCandidates('   ')
      await vi.advanceTimersByTimeAsync(250)
      await pending

      expect(mocks.api).toHaveBeenCalledWith('/api/v1/edition-links/candidates/10')
    })

    it('degrades to an empty list and sets searchError on a non-ok response', async () => {
      mocks.api.mockResolvedValueOnce(response(null, { ok: false, status: 500 }))
      const { candidates, searchError, searchCandidates } = await load(10)

      const pending = searchCandidates('x')
      await vi.advanceTimersByTimeAsync(250)
      await expect(pending).resolves.toEqual([])
      expect(candidates.value).toEqual([])
      expect(searchError.value).toBe('Failed to search for a matching book')
    })

    it('degrades to an empty list and sets searchError on a network exception', async () => {
      mocks.api.mockRejectedValueOnce(new Error('network down'))
      const { candidates, searchError, searchCandidates } = await load(10)

      const pending = searchCandidates('x')
      await vi.advanceTimersByTimeAsync(250)
      await expect(pending).resolves.toEqual([])
      expect(candidates.value).toEqual([])
      expect(searchError.value).toBe('Failed to search for a matching book')
    })

    it('clears a previous searchError once a later search succeeds', async () => {
      mocks.api.mockResolvedValueOnce(response(null, { ok: false, status: 500 }))
      mocks.api.mockResolvedValueOnce(response([{ bookId: 1, title: 'Found', authorName: null, score: 90 }]))
      const { searchError, searchCandidates } = await load(10)

      const first = searchCandidates('x')
      await vi.advanceTimersByTimeAsync(250)
      await first
      expect(searchError.value).toBe('Failed to search for a matching book')

      const second = searchCandidates('xy')
      await vi.advanceTimersByTimeAsync(250)
      await second
      expect(searchError.value).toBeNull()
    })

    it('clears searchError immediately when resetSearch is called', async () => {
      mocks.api.mockResolvedValueOnce(response(null, { ok: false, status: 500 }))
      const { searchError, searchCandidates, resetSearch } = await load(10)

      const pending = searchCandidates('x')
      await vi.advanceTimersByTimeAsync(250)
      await pending
      expect(searchError.value).toBe('Failed to search for a matching book')

      resetSearch()
      expect(searchError.value).toBeNull()
    })
  })

  describe('linkBook', () => {
    it('links the book, refreshes counterpart summary, and clears proposal/candidates', async () => {
      const created = { id: 5, textBookId: 10, audioBookId: 20, createdBy: 1, createdAt: '2026-01-01T00:00:00.000Z' }
      mocks.api.mockResolvedValueOnce(response(created))
      mocks.api.mockResolvedValueOnce(response(counterpartBook))

      const { link, proposed, candidates, mutating, linkBook } = await load(10)
      proposed.value = { bookId: 20, title: 'x', authorName: null, score: 50 }
      candidates.value = [{ bookId: 20, title: 'x', authorName: null, score: 50 }]

      const result = await linkBook(20)

      expect(mocks.api).toHaveBeenNthCalledWith(1, '/api/v1/edition-links/link/10', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ counterpartId: 20 }),
      })
      expect(result).toBe(true)
      expect(link.value).toEqual(created)
      expect(proposed.value).toBeNull()
      expect(candidates.value).toEqual([])
      expect(mutating.value).toBe(false)
    })

    it('returns false and sets an error when linking fails, without throwing', async () => {
      mocks.api.mockResolvedValueOnce(response(null, { ok: false, status: 409 }))

      const { link, error, linkBook } = await load(10)
      await expect(linkBook(20)).resolves.toBe(false)

      expect(link.value).toBeNull()
      expect(error.value).toBe('Failed to link book')
    })

    it('returns false on a network exception without throwing', async () => {
      mocks.api.mockRejectedValueOnce(new Error('boom'))

      const { error, linkBook } = await load(10)
      await expect(linkBook(20)).resolves.toBe(false)
      expect(error.value).toBe('Failed to link book')
    })
  })

  describe('unlink', () => {
    it('clears link state on success', async () => {
      mocks.api.mockResolvedValueOnce(response({ id: 5, textBookId: 10, audioBookId: 20, createdBy: 1, createdAt: '2026-01-01T00:00:00.000Z' }))

      const { link, linkedCounterpart, unlink } = await load(10)
      link.value = { id: 5, textBookId: 10, audioBookId: 20, createdBy: 1, createdAt: '2026-01-01T00:00:00.000Z' }
      linkedCounterpart.value = { bookId: 20, title: 'x', authorName: null, score: 100 }

      const result = await unlink()

      expect(mocks.api).toHaveBeenCalledWith('/api/v1/edition-links/link/10', { method: 'DELETE' })
      expect(result).toBe(true)
      expect(link.value).toBeNull()
      expect(linkedCounterpart.value).toBeNull()
    })

    it('returns false and sets an error when unlinking fails, without throwing', async () => {
      mocks.api.mockResolvedValueOnce(response(null, { ok: false, status: 404 }))

      const { error, unlink } = await load(10)
      await expect(unlink()).resolves.toBe(false)
      expect(error.value).toBe('Failed to unlink book')
    })

    it('returns false on a network exception without throwing', async () => {
      mocks.api.mockRejectedValueOnce(new Error('boom'))

      const { error, unlink } = await load(10)
      await expect(unlink()).resolves.toBe(false)
      expect(error.value).toBe('Failed to unlink book')
    })
  })

  describe('shared state across sibling controls (same bookId)', () => {
    it('reflects a link made through one instance in another instance for the same bookId', async () => {
      const created = { id: 5, textBookId: 10, audioBookId: 20, createdBy: 1, createdAt: '2026-01-01T00:00:00.000Z' }
      mocks.api.mockResolvedValueOnce(response(created))
      mocks.api.mockResolvedValueOnce(response(counterpartBook))

      const mod = await import('../useEditionLink')
      const controlA = mod.useEditionLink(10)
      const controlB = mod.useEditionLink(10)

      expect(controlB.link.value).toBeNull()

      await controlA.linkBook(20)

      expect(controlA.link.value).toEqual(created)
      expect(controlB.link.value).toEqual(created)
      expect(controlB.linkedCounterpart.value).toEqual({ bookId: 20, title: 'Counterpart Title', authorName: 'Jane Author', score: 100 })
    })

    it('reflects an unlink made through one instance in another instance for the same bookId', async () => {
      mocks.api.mockResolvedValueOnce(response({ id: 5, textBookId: 10, audioBookId: 20, createdBy: 1, createdAt: '2026-01-01T00:00:00.000Z' }))

      const mod = await import('../useEditionLink')
      const controlA = mod.useEditionLink(10)
      const controlB = mod.useEditionLink(10)
      controlA.link.value = { id: 5, textBookId: 10, audioBookId: 20, createdBy: 1, createdAt: '2026-01-01T00:00:00.000Z' }
      controlA.linkedCounterpart.value = { bookId: 20, title: 'x', authorName: null, score: 100 }

      await controlB.unlink()

      expect(controlA.link.value).toBeNull()
      expect(controlA.linkedCounterpart.value).toBeNull()
    })

    it('keeps state isolated between different bookIds', async () => {
      const mod = await import('../useEditionLink')
      const bookTen = mod.useEditionLink(10)
      const bookEleven = mod.useEditionLink(11)

      bookTen.link.value = { id: 1, textBookId: 10, audioBookId: 20, createdBy: 1, createdAt: '2026-01-01T00:00:00.000Z' }

      expect(bookEleven.link.value).toBeNull()
    })

    it('drops the shared entry once every consumer scope disposes, so a later mount starts fresh', async () => {
      const mod = await import('../useEditionLink')

      const scope = effectScope()
      scope.run(() => {
        const control = mod.useEditionLink(10)
        control.link.value = { id: 1, textBookId: 10, audioBookId: 20, createdBy: 1, createdAt: '2026-01-01T00:00:00.000Z' }
      })
      scope.stop()

      const later = mod.useEditionLink(10)
      expect(later.link.value).toBeNull()
    })

    it('does not pin the entry in place when called outside a component scope, so a scoped consumer can still reclaim it', async () => {
      const mod = await import('../useEditionLink')

      // Calls with no active effectScope (e.g. a plain function, not <script setup>) must not register
      // an unmatched refCount increment - otherwise the entry could never be released later.
      mod.useEditionLink(10)
      mod.useEditionLink(10)

      const scope = effectScope()
      scope.run(() => {
        const control = mod.useEditionLink(10)
        control.link.value = { id: 1, textBookId: 10, audioBookId: 20, createdBy: 1, createdAt: '2026-01-01T00:00:00.000Z' }
      })
      scope.stop()

      const later = mod.useEditionLink(10)
      expect(later.link.value).toBeNull()
    })
  })
})

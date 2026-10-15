import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import type { WebSerialMangaExtension, WebSerialMangaExtensionPage } from '@bookorbit/types'

const api = vi.hoisted(() => ({
  fetchMangaExtensions: vi.fn<(query: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>>(),
  refreshMangaExtensions: vi.fn<() => Promise<unknown>>(),
  runMangaExtensionAction: vi.fn<(pkg: string, action: string) => Promise<unknown>>(),
  fetchMangaRepos: vi.fn<() => Promise<unknown>>(),
  addMangaRepo: vi.fn<(input: unknown) => Promise<unknown>>(),
  removeMangaRepo: vi.fn<(url: string) => Promise<unknown>>(),
}))

vi.mock('../api/webSerials', () => api)

import { EXTENSION_PAGE_SIZE, isRepoUrl, useWebSerialExtensions } from '../composables/useWebSerialExtensions'

function ext(pkgName: string, overrides: Partial<WebSerialMangaExtension> = {}): WebSerialMangaExtension {
  return {
    pkgName,
    name: pkgName,
    lang: 'en',
    versionName: '1.0',
    installed: false,
    hasUpdate: false,
    adult: false,
    iconUrl: null,
    repo: null,
    ...overrides,
  }
}

function page(items: WebSerialMangaExtension[], total = items.length): WebSerialMangaExtensionPage {
  return { items, total, languages: ['en', 'ja'] }
}

function setup(onChanged = vi.fn<() => void>()) {
  const scope = effectScope()
  const state = scope.run(() => useWebSerialExtensions(onChanged))!
  return { state, onChanged, scope }
}

describe('useWebSerialExtensions', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    Object.values(api).forEach((fn) => fn.mockReset())
    api.fetchMangaRepos.mockResolvedValue(['https://r.example/index.pb'])
    api.fetchMangaExtensions.mockImplementation(async (query) =>
      query.installed ? page([ext('a.installed', { installed: true })]) : page([ext('a.one')]),
    )
  })
  afterEach(() => vi.useRealTimers())

  it('loads installed, available and repos when opened', async () => {
    const { state } = setup()
    await state.open()
    expect(state.installed.value.map((e) => e.pkgName)).toEqual(['a.installed'])
    expect(state.available.value.map((e) => e.pkgName)).toEqual(['a.one'])
    expect(state.languages.value).toEqual(['en', 'ja'])
    expect(state.repos.value).toEqual(['https://r.example/index.pb'])
    expect(api.fetchMangaExtensions).toHaveBeenCalledWith(
      expect.objectContaining({ adult: false, limit: EXTENSION_PAGE_SIZE, offset: 0 }),
      expect.anything(),
    )
  })

  it('pages the installed list past the first 100 so every extension can be reached', async () => {
    const first = Array.from({ length: 100 }, (_, i) => ext(`i.${i}`, { installed: true }))
    api.fetchMangaExtensions.mockResolvedValueOnce(page(first, 101)).mockResolvedValueOnce(page([ext('i.100', { installed: true })], 101))
    const { state } = setup()
    await state.loadInstalled()
    expect(state.installedTotal.value).toBe(101)
    state.loadMoreInstalled()
    await vi.advanceTimersByTimeAsync(0)
    expect(api.fetchMangaExtensions).toHaveBeenLastCalledWith(expect.objectContaining({ installed: true, offset: 100 }))
    expect(state.installed.value).toHaveLength(101)
  })

  it('pages with load more using the loaded count as the offset', async () => {
    const first = Array.from({ length: 50 }, (_, i) => ext(`p.${i}`))
    api.fetchMangaExtensions.mockResolvedValueOnce(page(first, 60)).mockResolvedValueOnce(page([ext('p.50')], 60))
    const { state } = setup()
    await state.setShowAdult(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(state.hasMore.value).toBe(true)
    state.loadMore()
    await vi.advanceTimersByTimeAsync(0)
    expect(api.fetchMangaExtensions).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 50 }), expect.anything())
    expect(state.available.value).toHaveLength(51)
  })

  it('debounces search by 300 ms and resets paging', async () => {
    const { state } = setup()
    state.setSearch('on')
    state.setSearch('one')
    await vi.advanceTimersByTimeAsync(299)
    expect(api.fetchMangaExtensions).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(api.fetchMangaExtensions).toHaveBeenCalledTimes(1)
    expect(api.fetchMangaExtensions).toHaveBeenCalledWith(expect.objectContaining({ query: 'one', offset: 0 }), expect.anything())
  })

  it('sends language and adult filters immediately', async () => {
    const { state } = setup()
    state.setLang('ja')
    state.setShowAdult(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(api.fetchMangaExtensions).toHaveBeenLastCalledWith(expect.objectContaining({ lang: 'ja', adult: true }), expect.anything())
  })

  it('installs, marks the row installed, reloads installed and notifies', async () => {
    api.runMangaExtensionAction.mockResolvedValue(ext('a.one', { installed: true }))
    const { state, onChanged } = setup()
    await state.open()
    const done = await state.install(state.available.value[0]!)
    expect(done).toBe(true)
    expect(api.runMangaExtensionAction).toHaveBeenCalledWith('a.one', 'install')
    expect(state.available.value[0]!.installed).toBe(true)
    expect(onChanged).toHaveBeenCalledOnce()
    expect(state.busy['a.one']).toBeUndefined()
  })

  it('keeps the failure message and does not notify when an install fails', async () => {
    api.runMangaExtensionAction.mockRejectedValue(new Error('The manga engine did not answer.'))
    const { state, onChanged } = setup()
    await state.open()
    expect(await state.install(state.available.value[0]!)).toBe(false)
    expect(state.actionError.value).toBe('The manga engine did not answer.')
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('uninstalls only after the confirm step', async () => {
    api.runMangaExtensionAction.mockResolvedValue(ext('a.installed'))
    const { state } = setup()
    await state.open()
    state.requestUninstall(state.installed.value[0]!)
    expect(api.runMangaExtensionAction).not.toHaveBeenCalled()
    state.cancelUninstall()
    expect(state.pendingUninstall.value).toBeNull()
    state.requestUninstall(state.installed.value[0]!)
    await state.confirmUninstall()
    expect(api.runMangaExtensionAction).toHaveBeenCalledWith('a.installed', 'uninstall')
    expect(state.pendingUninstall.value).toBeNull()
  })

  it('refreshes the catalogue then reloads the lists', async () => {
    api.refreshMangaExtensions.mockResolvedValue({ total: 5 })
    const { state } = setup()
    await state.refreshList()
    expect(api.refreshMangaExtensions).toHaveBeenCalledOnce()
    expect(api.fetchMangaExtensions).toHaveBeenCalledTimes(2)
    expect(state.refreshing.value).toBe(false)
  })

  it('adds a valid repository and rejects an invalid one without calling the server', async () => {
    api.addMangaRepo.mockResolvedValue(undefined)
    const { state } = setup()
    expect(await state.addRepo('ftp://nope')).toBe(false)
    expect(api.addMangaRepo).not.toHaveBeenCalled()
    expect(await state.addRepo(' https://r.example/index.pb ')).toBe(true)
    expect(api.addMangaRepo).toHaveBeenCalledWith({ url: 'https://r.example/index.pb' })
  })

  it('removes a repository', async () => {
    api.removeMangaRepo.mockResolvedValue(undefined)
    const { state } = setup()
    await state.open()
    api.fetchMangaRepos.mockResolvedValue([])
    expect(await state.removeRepo('https://r.example/index.pb')).toBe(true)
    expect(state.repos.value).toEqual([])
  })

  it('validates repository urls', () => {
    expect(isRepoUrl('https://a.b/c')).toBe(true)
    expect(isRepoUrl('http://a.b')).toBe(true)
    expect(isRepoUrl('javascript:alert(1)')).toBe(false)
    expect(isRepoUrl('not a url')).toBe(false)
  })
})

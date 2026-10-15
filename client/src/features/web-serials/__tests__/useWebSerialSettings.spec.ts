import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebSerialSettings } from '@bookorbit/types'
import { useWebSerialSettings } from '../composables/useWebSerialSettings'
import { buildSettingsPayload, draftFromSettings, sameServer } from '../lib/settingsDraft'

const api = vi.hoisted(() => ({
  fetchWebSerialSettings: vi.fn<() => Promise<unknown>>(),
  saveWebSerialSettings: vi.fn<(payload: unknown) => Promise<unknown>>(),
  testWebSerialEngine: vi.fn<(input: unknown) => Promise<unknown>>(),
  fetchNovelSources: vi.fn<() => Promise<unknown>>(),
  fetchMangaSources: vi.fn<() => Promise<unknown>>(),
}))

vi.mock('../api/webSerials', () => api)

beforeEach(() => {
  vi.clearAllMocks()
})

function settings(overrides: Partial<WebSerialSettings> = {}): WebSerialSettings {
  return {
    manga: {
      url: 'http://suwayomi:4567',
      username: 'bo',
      passwordConfigured: true,
      lastCheck: null,
      sourceIds: null,
      languages: ['en'],
      targetLibraryId: 3,
      targetFolderId: 31,
    },
    novel: {
      engine: 'lncrawl',
      url: 'http://lncrawl:8080',
      username: 'admin',
      passwordConfigured: true,
      lastCheck: null,
      searchDomains: ['novelbuddy.com'],
      sourceIds: [],
      targetLibraryId: 1,
      targetFolderId: null,
      defaultPackaging: 'volume',
      indexDailyBudget: 1500,
    },
    maxConcurrentJobs: 2,
    lookup: { enabled: true, lastCheck: null },
    ...overrides,
  }
}

describe('buildSettingsPayload', () => {
  it('sends nothing when nothing changed', () => {
    const current = settings()
    expect(buildSettingsPayload(draftFromSettings(current), current)).toEqual({})
  })

  it('sends only the fields that changed, per engine', () => {
    const current = settings()
    const draft = draftFromSettings(current)
    draft.manga.languages = ['en', 'ja']
    draft.novel.defaultPackaging = 'series'
    draft.maxConcurrentJobs = 4

    expect(buildSettingsPayload(draft, current)).toEqual({
      manga: { languages: ['en', 'ja'] },
      novel: { defaultPackaging: 'series' },
      maxConcurrentJobs: 4,
    })
  })

  it('sends a password only when one was typed', () => {
    const current = settings()
    const draft = draftFromSettings(current)
    draft.manga.username = 'renamed'
    expect(buildSettingsPayload(draft, current).manga).toEqual({ username: 'renamed' })

    draft.manga.password = '  secret  '
    expect(buildSettingsPayload(draft, current).manga).toEqual({ username: 'renamed', password: 'secret' })
  })

  it('clears a connection field by sending null', () => {
    const current = settings()
    const draft = draftFromSettings(current)
    draft.novel.url = ''
    draft.novel.targetLibraryId = null
    expect(buildSettingsPayload(draft, current).novel).toEqual({ url: null, targetLibraryId: null })
  })
})

describe('manga source selection payload', () => {
  it('keeps a legacy null selection unsent until the draft picks sources', () => {
    const current = settings()
    const draft = draftFromSettings(current)
    expect(draft.manga.sourceIds).toBeNull()
    expect(buildSettingsPayload(draft, current)).toEqual({})

    draft.manga.sourceIds = ['1', '2']
    expect(buildSettingsPayload(draft, current)).toEqual({ manga: { sourceIds: ['1', '2'] } })
  })

  it('sends an empty selection and ignores a reordered identical one', () => {
    const current = settings({ manga: { ...settings().manga, sourceIds: ['1', '2'] } })
    const draft = draftFromSettings(current)
    draft.manga.sourceIds = ['2', '1']
    expect(buildSettingsPayload(draft, current)).toEqual({})

    draft.manga.sourceIds = []
    expect(buildSettingsPayload(draft, current)).toEqual({ manga: { sourceIds: [] } })
  })
})

describe('sameServer', () => {
  it('ignores a trailing slash and surrounding space', () => {
    expect(sameServer('http://suwayomi:4567/', ' http://suwayomi:4567 ')).toBe(true)
    expect(sameServer('http://suwayomi:4567', 'http://other:4567')).toBe(false)
  })
})

describe('buildSettingsPayload parts', () => {
  it('keeps connection edits out of the page payload and the reverse', () => {
    const current = settings()
    const draft = draftFromSettings(current)
    draft.manga.url = 'http://other:4567'
    draft.manga.languages = ['en', 'ja']
    draft.maxConcurrentJobs = 3

    expect(buildSettingsPayload(draft, current, 'page')).toEqual({ manga: { languages: ['en', 'ja'] }, maxConcurrentJobs: 3 })
    expect(buildSettingsPayload(draft, current, 'connection')).toEqual({ manga: { url: 'http://other:4567' } })
  })
})

describe('useWebSerialSettings', () => {
  it('saves a changed daily index budget with the page and refuses one out of range', async () => {
    api.fetchWebSerialSettings.mockResolvedValue(settings())
    const state = useWebSerialSettings()
    await state.load()

    state.draft.novel.indexDailyBudget = 5
    expect(state.indexBudgetInvalid.value).toBe(true)
    expect(state.pageInvalid.value).toBe(true)
    expect(await state.savePage()).toBe(false)

    state.draft.novel.indexDailyBudget = 400
    expect(buildSettingsPayload(state.draft, settings(), 'page')).toEqual({ novel: { indexDailyBudget: 400 } })
    api.saveWebSerialSettings.mockResolvedValue(settings())
    expect(await state.savePage()).toBe(true)
    expect(api.saveWebSerialSettings).toHaveBeenCalledWith({ novel: { indexDailyBudget: 400 } })
    expect(buildSettingsPayload(state.draft, settings(), 'connection')).toEqual({})
  })

  it('saves page changes without touching an unsaved connection edit', async () => {
    api.fetchWebSerialSettings.mockResolvedValue(settings())
    const state = useWebSerialSettings()
    await state.load()
    state.draft.manga.username = 'typing'
    state.draft.maxConcurrentJobs = 4
    api.saveWebSerialSettings.mockResolvedValue(settings({ maxConcurrentJobs: 4 }))

    expect(state.hasPageChanges.value).toBe(true)
    expect(await state.savePage()).toBe(true)

    expect(api.saveWebSerialSettings).toHaveBeenCalledWith({ maxConcurrentJobs: 4 })
    expect(state.draft.manga.username).toBe('typing')
    expect(state.hasPageChanges.value).toBe(false)
  })

  it('saves one engine connection and keeps unsaved page edits', async () => {
    api.fetchWebSerialSettings.mockResolvedValue(settings())
    api.fetchMangaSources.mockResolvedValue([])
    const state = useWebSerialSettings()
    await state.load()
    state.draft.manga.username = 'renamed'
    state.draft.novel.username = 'other'
    state.draft.maxConcurrentJobs = 5
    api.saveWebSerialSettings.mockResolvedValue(settings({ maxConcurrentJobs: 2 }))

    expect(await state.saveConnection('manga')).toBe(true)

    expect(api.saveWebSerialSettings).toHaveBeenCalledWith({ manga: { username: 'renamed' } })
    expect(state.draft.maxConcurrentJobs).toBe(5)
    expect(state.hasPageChanges.value).toBe(true)
  })

  it('blocks a connection save that would drop the stored password', async () => {
    api.fetchWebSerialSettings.mockResolvedValue(settings())
    const state = useWebSerialSettings()
    await state.load()
    state.draft.manga.url = 'http://new:4567'

    expect(state.canSaveConnection('manga')).toBe(false)
    state.draft.manga.password = 'secret'
    expect(state.canSaveConnection('manga')).toBe(true)
  })

  it('rejects an out-of-range download count and discards page edits', async () => {
    api.fetchWebSerialSettings.mockResolvedValue(settings())
    const state = useWebSerialSettings()
    await state.load()
    state.draft.maxConcurrentJobs = 9

    expect(state.maxJobsInvalid.value).toBe(true)
    expect(state.canSavePage.value).toBe(false)
    state.discardPage()
    expect(state.draft.maxConcurrentJobs).toBe(2)
  })

  it('resets a cancelled connection edit and its test result', async () => {
    api.fetchWebSerialSettings.mockResolvedValue(settings())
    const state = useWebSerialSettings()
    await state.load()
    state.draft.manga.url = 'http://typed'
    state.draft.manga.password = 'x'
    api.testWebSerialEngine.mockResolvedValue({ ok: false, checkedAt: 'now', version: null, searchableSources: 0, error: 'down' })
    await state.test('manga')
    expect(state.testResults.value.manga?.ok).toBe(false)

    state.resetConnection('manga')

    expect(state.draft.manga.url).toBe('http://suwayomi:4567')
    expect(state.draft.manga.password).toBe('')
    expect(state.testResults.value.manga).toBeNull()
  })

  it('loads manga sources only for a configured engine', async () => {
    const state = useWebSerialSettings()
    await state.loadMangaSources()
    expect(api.fetchMangaSources).not.toHaveBeenCalled()

    api.fetchWebSerialSettings.mockResolvedValue(settings())
    api.fetchMangaSources.mockResolvedValue([{ id: '1', name: 'A (EN)', lang: 'en', nsfw: false }])
    await state.load()
    await state.loadMangaSources()
    expect(state.mangaSources.value).toHaveLength(1)
  })
  it('drops sources of an uninstalled extension from the draft so saving does not write them back', async () => {
    const base = settings()
    api.fetchWebSerialSettings.mockResolvedValue(settings({ manga: { ...base.manga, sourceIds: ['s1', 's2', 's3'] } }))
    api.fetchMangaSources.mockResolvedValue([
      { id: 's1', name: 'A', lang: 'en', nsfw: false },
      { id: 's2', name: 'B', lang: 'en', nsfw: false },
      { id: 's3', name: 'C', lang: 'en', nsfw: false },
    ])
    const state = useWebSerialSettings()
    await state.load()
    await state.loadMangaSources()

    api.fetchMangaSources.mockResolvedValue([{ id: 's3', name: 'C', lang: 'en', nsfw: false }])
    await state.loadMangaSources()
    state.pruneSelectedSources()

    expect(state.draft.manga.sourceIds).toEqual(['s3'])
    expect(state.hasPageChanges.value).toBe(false)
  })

  it('is not dirty after toggling a search domain off and on again', async () => {
    const base = settings()
    api.fetchWebSerialSettings.mockResolvedValue(settings({ novel: { ...base.novel, searchDomains: ['a.com', 'b.com'] } }))
    const state = useWebSerialSettings()
    await state.load()
    state.draft.novel.searchDomains = ['b.com', 'a.com']
    expect(state.hasPageChanges.value).toBe(false)
  })
})

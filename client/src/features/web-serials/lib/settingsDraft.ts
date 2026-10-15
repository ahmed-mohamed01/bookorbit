import type { UpdateWebSerialSettingsInput, WebSerialNovelEngine, WebSerialPackaging, WebSerialSettings } from '@bookorbit/types'

export interface WebSerialEngineDraft {
  url: string
  username: string
  password: string
  targetLibraryId: number | null
  targetFolderId: number | null
}

export interface WebSerialSettingsDraft {
  manga: WebSerialEngineDraft & { languages: string[]; sourceIds: string[] | null }
  novel: WebSerialEngineDraft & {
    engine: WebSerialNovelEngine
    searchDomains: string[]
    sourceIds: string[]
    defaultPackaging: Extract<WebSerialPackaging, 'volume' | 'series'>
    indexDailyBudget: number
  }
  maxConcurrentJobs: number
  lookupEnabled: boolean
}

export function emptyDraft(): WebSerialSettingsDraft {
  return {
    manga: { url: '', username: '', password: '', targetLibraryId: null, targetFolderId: null, languages: ['en'], sourceIds: null },
    novel: {
      engine: 'lnreader',
      url: '',
      username: '',
      password: '',
      targetLibraryId: null,
      targetFolderId: null,
      searchDomains: [],
      sourceIds: [],
      defaultPackaging: 'volume',
      indexDailyBudget: DEFAULT_INDEX_DAILY_BUDGET,
    },
    maxConcurrentJobs: 2,
    lookupEnabled: true,
  }
}

export function draftFromSettings(settings: WebSerialSettings): WebSerialSettingsDraft {
  return {
    manga: {
      url: settings.manga.url ?? '',
      username: settings.manga.username ?? '',
      password: '',
      targetLibraryId: settings.manga.targetLibraryId,
      targetFolderId: settings.manga.targetFolderId,
      languages: [...settings.manga.languages],
      sourceIds: settings.manga.sourceIds ? [...settings.manga.sourceIds] : null,
    },
    novel: {
      engine: novelEngineOf(settings),
      url: settings.novel.url ?? '',
      username: settings.novel.username ?? '',
      password: '',
      targetLibraryId: settings.novel.targetLibraryId,
      targetFolderId: settings.novel.targetFolderId,
      searchDomains: [...settings.novel.searchDomains],
      sourceIds: [...(settings.novel.sourceIds ?? [])],
      defaultPackaging: settings.novel.defaultPackaging,
      indexDailyBudget: settings.novel.indexDailyBudget ?? DEFAULT_INDEX_DAILY_BUDGET,
    },
    maxConcurrentJobs: settings.maxConcurrentJobs,
    lookupEnabled: settings.lookup.enabled,
  }
}

export function sameServer(a: string, b: string): boolean {
  return a.trim().replace(/\/+$/, '') === b.trim().replace(/\/+$/, '')
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value) => b.includes(value))
}

function novelEngineOf(settings: WebSerialSettings): WebSerialNovelEngine {
  return settings.novel.engine ?? (settings.novel.url ? 'lncrawl' : 'lnreader')
}

export type SettingsPart = 'all' | 'connection' | 'page'

export const MIN_INDEX_DAILY_BUDGET = 10
export const MAX_INDEX_DAILY_BUDGET = 20000
export const DEFAULT_INDEX_DAILY_BUDGET = 1500

export const MIN_CONCURRENT_JOBS = 1
export const MAX_CONCURRENT_JOBS = 6

/**
 * Only what changed goes out. The stored password is never readable, so it is sent when the admin
 * typed a replacement and never because some other field changed.
 */
export function buildSettingsPayload(
  draft: WebSerialSettingsDraft,
  current: WebSerialSettings,
  part: SettingsPart = 'all',
): UpdateWebSerialSettingsInput {
  const payload: UpdateWebSerialSettingsInput = {}
  const withConnection = part !== 'page'
  const withPage = part !== 'connection'

  const manga: NonNullable<UpdateWebSerialSettingsInput['manga']> = {}
  if (withConnection) {
    const mangaUrl = draft.manga.url.trim()
    if (mangaUrl !== (current.manga.url ?? '')) manga.url = mangaUrl || null
    const mangaUser = draft.manga.username.trim()
    if (mangaUser !== (current.manga.username ?? '')) manga.username = mangaUser || null
    if (draft.manga.password.trim()) manga.password = draft.manga.password.trim()
  }
  if (withPage) {
    if (!sameSet(draft.manga.languages, current.manga.languages)) manga.languages = draft.manga.languages
    if (draft.manga.sourceIds && !(current.manga.sourceIds && sameSet(draft.manga.sourceIds, current.manga.sourceIds))) {
      manga.sourceIds = draft.manga.sourceIds
    }
    if (draft.manga.targetLibraryId !== current.manga.targetLibraryId) manga.targetLibraryId = draft.manga.targetLibraryId
    if (draft.manga.targetFolderId !== current.manga.targetFolderId) manga.targetFolderId = draft.manga.targetFolderId
  }
  if (Object.keys(manga).length > 0) payload.manga = manga

  const novel: NonNullable<UpdateWebSerialSettingsInput['novel']> = {}
  if (withConnection) {
    if (draft.novel.engine !== novelEngineOf(current)) novel.engine = draft.novel.engine
    const novelUrl = draft.novel.url.trim()
    if (novelUrl !== (current.novel.url ?? '')) novel.url = novelUrl || null
    const novelUser = draft.novel.username.trim()
    if (novelUser !== (current.novel.username ?? '')) novel.username = novelUser || null
    if (draft.novel.password.trim()) novel.password = draft.novel.password.trim()
  }
  if (withPage) {
    if (!sameSet(draft.novel.searchDomains, current.novel.searchDomains)) novel.searchDomains = draft.novel.searchDomains
    if (!sameSet(draft.novel.sourceIds, current.novel.sourceIds ?? [])) novel.sourceIds = draft.novel.sourceIds
    if (draft.novel.targetLibraryId !== current.novel.targetLibraryId) novel.targetLibraryId = draft.novel.targetLibraryId
    if (draft.novel.targetFolderId !== current.novel.targetFolderId) novel.targetFolderId = draft.novel.targetFolderId
    if (draft.novel.defaultPackaging !== current.novel.defaultPackaging) novel.defaultPackaging = draft.novel.defaultPackaging
    if (draft.novel.indexDailyBudget !== (current.novel.indexDailyBudget ?? DEFAULT_INDEX_DAILY_BUDGET)) {
      novel.indexDailyBudget = draft.novel.indexDailyBudget
    }
  }
  if (Object.keys(novel).length > 0) payload.novel = novel

  if (withPage && draft.maxConcurrentJobs !== current.maxConcurrentJobs) payload.maxConcurrentJobs = draft.maxConcurrentJobs
  if (withPage && draft.lookupEnabled !== current.lookup.enabled) payload.lookup = { enabled: draft.lookupEnabled }
  return payload
}

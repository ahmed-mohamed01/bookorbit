import { computed, reactive, ref } from 'vue'
import type { WebSerialEngineHealth, WebSerialKind, WebSerialSettings } from '@bookorbit/types'
import { fetchWebSerialSettings, saveWebSerialSettings } from '../api/webSerials'
import { messageOf } from '../lib/messageOf'
import {
  buildSettingsPayload,
  draftFromSettings,
  emptyDraft,
  MAX_CONCURRENT_JOBS,
  MAX_INDEX_DAILY_BUDGET,
  MIN_CONCURRENT_JOBS,
  MIN_INDEX_DAILY_BUDGET,
  sameServer,
  type SettingsPart,
  type WebSerialSettingsDraft,
} from '../lib/settingsDraft'
import { useWebSerialEngineTest } from './useWebSerialEngineTest'
import { useWebSerialLookupCheck } from './useWebSerialLookupCheck'
import { useWebSerialSourceLists } from './useWebSerialSourceLists'

function maxJobsValid(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_CONCURRENT_JOBS && value <= MAX_CONCURRENT_JOBS
}

function indexBudgetValid(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_INDEX_DAILY_BUDGET && value <= MAX_INDEX_DAILY_BUDGET
}

export function useWebSerialSettings() {
  const settings = ref<WebSerialSettings | null>(null)
  const draft = reactive<WebSerialSettingsDraft>(emptyDraft())
  const loading = ref(false)
  const saving = ref(false)
  const loadError = ref<string | null>(null)
  const saveError = ref<string | null>(null)
  const engineTest = useWebSerialEngineTest()
  const lookupCheck = useWebSerialLookupCheck()
  const sourceLists = useWebSerialSourceLists(settings, draft)
  const { testing, testResults, testError } = engineTest
  const { lookupHealth, testingLookup, lookupTestError, runLookupTest } = lookupCheck
  const { loadNovelSources, loadMangaSources, pruneSelectedSources } = sourceLists

  /** A connection save must not wipe unsaved page edits, and a page save must not wipe an open connection sheet. */
  function applySettings(value: WebSerialSettings, part: SettingsPart = 'all'): void {
    settings.value = value
    const fresh = draftFromSettings(value)
    if (part !== 'page') {
      for (const kind of ['manga', 'novel'] as const) {
        draft[kind].url = fresh[kind].url
        draft[kind].username = fresh[kind].username
        draft[kind].password = ''
      }
      draft.novel.engine = fresh.novel.engine
    }
    if (part !== 'connection') {
      draft.manga.languages = fresh.manga.languages
      draft.manga.sourceIds = fresh.manga.sourceIds
      draft.manga.targetLibraryId = fresh.manga.targetLibraryId
      draft.manga.targetFolderId = fresh.manga.targetFolderId
      draft.novel.searchDomains = fresh.novel.searchDomains
      draft.novel.sourceIds = fresh.novel.sourceIds
      draft.novel.targetLibraryId = fresh.novel.targetLibraryId
      draft.novel.targetFolderId = fresh.novel.targetFolderId
      draft.novel.defaultPackaging = fresh.novel.defaultPackaging
      draft.novel.indexDailyBudget = fresh.novel.indexDailyBudget
      draft.maxConcurrentJobs = fresh.maxConcurrentJobs
      draft.lookupEnabled = fresh.lookupEnabled
    }
    engineTest.showResult('manga', value.manga.lastCheck)
    engineTest.showResult('novel', value.novel.lastCheck)
    lookupHealth.value = value.lookup.lastCheck
  }

  /** A changed host drops the stored password server-side, so a blank password box no longer means "keep it". */
  const passwordWillBeCleared = computed<Record<WebSerialKind, boolean>>(() => {
    const current = settings.value
    if (!current) return { manga: false, novel: false }
    return {
      manga: current.manga.passwordConfigured && !draft.manga.password.trim() && !sameServer(draft.manga.url, current.manga.url ?? ''),
      novel: current.novel.passwordConfigured && !draft.novel.password.trim() && !sameServer(draft.novel.url, current.novel.url ?? ''),
    }
  })

  const hasPageChanges = computed(() => settings.value !== null && Object.keys(buildSettingsPayload(draft, settings.value, 'page')).length > 0)
  const maxJobsInvalid = computed(() => !maxJobsValid(draft.maxConcurrentJobs))
  const indexBudgetInvalid = computed(() => !indexBudgetValid(draft.novel.indexDailyBudget))
  const pageInvalid = computed(() => maxJobsInvalid.value || indexBudgetInvalid.value)
  const canSavePage = computed(() => hasPageChanges.value && !saving.value && !pageInvalid.value)

  const connectionDirty = computed<Record<WebSerialKind, boolean>>(() => {
    const current = settings.value
    if (!current) return { manga: false, novel: false }
    const payload = buildSettingsPayload(draft, current, 'connection')
    return { manga: Boolean(payload.manga), novel: Boolean(payload.novel) }
  })

  function canSaveConnection(kind: WebSerialKind): boolean {
    return connectionDirty.value[kind] && !saving.value && !passwordWillBeCleared.value[kind]
  }

  async function load(): Promise<void> {
    loading.value = true
    loadError.value = null
    try {
      applySettings(await fetchWebSerialSettings())
    } catch (cause) {
      loadError.value = messageOf(cause, 'webSerials.api.loadSettings')
    } finally {
      loading.value = false
    }
  }

  async function submit(part: Exclude<SettingsPart, 'all'>, kind?: WebSerialKind): Promise<boolean> {
    if (!settings.value) return false
    let payload = buildSettingsPayload(draft, settings.value, part)
    if (kind) payload = kind === 'manga' ? { manga: payload.manga } : { novel: payload.novel }
    if (Object.keys(payload).length === 0 || (kind && !payload[kind])) return false
    saving.value = true
    saveError.value = null
    try {
      applySettings(await saveWebSerialSettings(payload), part)
      return true
    } catch (cause) {
      saveError.value = messageOf(cause, 'webSerials.api.saveSettings')
      return false
    } finally {
      saving.value = false
    }
  }

  async function savePage(): Promise<boolean> {
    if (!canSavePage.value) return false
    return submit('page')
  }

  async function saveConnection(kind: WebSerialKind): Promise<boolean> {
    if (!canSaveConnection(kind)) return false
    const saved = await submit('connection', kind)
    if (saved) {
      if (kind === 'manga') await loadMangaSources()
      else await loadNovelSources()
    }
    return saved
  }

  function discardPage(): void {
    if (!settings.value) return
    applySettings(settings.value, 'page')
  }

  function resetConnection(kind: WebSerialKind): void {
    const current = settings.value
    if (!current) return
    draft[kind].url = current[kind].url ?? ''
    draft[kind].username = current[kind].username ?? ''
    draft[kind].password = ''
    if (kind === 'novel') draft.novel.engine = draftFromSettings(current).novel.engine
    engineTest.showResult(kind, current[kind].lastCheck)
    engineTest.clearError(kind)
    saveError.value = null
  }

  function test(kind: WebSerialKind): Promise<WebSerialEngineHealth | null> {
    return engineTest.test(kind, draft[kind])
  }

  return {
    settings,
    draft,
    loading,
    saving,
    loadError,
    saveError,
    testing,
    testResults,
    testError,
    lookupHealth,
    testingLookup,
    lookupTestError,
    novelSources: sourceLists.novelSources,
    novelSourcesLoading: sourceLists.novelSourcesLoading,
    novelSourcesError: sourceLists.novelSourcesError,
    mangaSources: sourceLists.mangaSources,
    mangaSourcesLoading: sourceLists.mangaSourcesLoading,
    mangaSourcesError: sourceLists.mangaSourcesError,
    passwordWillBeCleared,
    hasPageChanges,
    maxJobsInvalid,
    indexBudgetInvalid,
    pageInvalid,
    canSavePage,
    connectionDirty,
    canSaveConnection,
    load,
    savePage,
    saveConnection,
    discardPage,
    resetConnection,
    test,
    runLookupTest,
    loadNovelSources,
    loadMangaSources,
    pruneSelectedSources,
  }
}

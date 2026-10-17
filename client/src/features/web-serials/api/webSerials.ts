import { apiJson, apiSend, jsonBody } from './http'
import type {
  CreateWebSerialJobInput,
  MoveWebSerialJobInput,
  MoveWebSerialJobResult,
  ResolveWebSerialUrlInput,
  TestWebSerialEngineInput,
  UpdateWebSerialNovelProvidersInput,
  UpdateWebSerialSettingsInput,
  WebSerialCapabilities,
  WebSerialCatalogEntry,
  WebSerialEngineHealth,
  WebSerialClearFinishedResult,
  WebSerialDiscoverResult,
  WebSerialKind,
  WebSerialJob,
  WebSerialJobDetail,
  WebSerialJobList,
  WebSerialJobScope,
  WebSerialLookupHealth,
  WebSerialMoveCandidates,
  WebSerialExtensionRepoInput,
  WebSerialMangaExtension,
  WebSerialMangaExtensionPage,
  WebSerialMangaExtensionQuery,
  WebSerialMangaSource,
  WebSerialNovelIndexStatus,
  WebSerialNovelProviders,
  WebSerialNovelSource,
  WebSerialNovelSourceEntry,
  WebSerialSearchResult,
  WebSerialSeriesDetail,
  WebSerialSeriesLookup,
  WebSerialSourceOptions,
  WebSerialSettings,
  WebSerialSuggestResult,
} from '@bookorbit/types'

const BASE = '/api/v1/web-serials'

export type WebSerialSearchScope = 'all' | 'manga' | 'novel'

export function seriesCoverPath(seriesKey: string): string {
  return `${BASE}/series/${encodeURIComponent(seriesKey)}/cover`
}

export async function fetchCapabilities(): Promise<WebSerialCapabilities> {
  return apiJson(`${BASE}/capabilities`, undefined, 'webSerials.api.capabilities')
}

/**
 * `refresh` asks the server to skip its cached answer and query the sources again. `phase: 'index'` (novels) answers from
 * the light novel index only, at once; `livePending` then says whether the full search still has sources to ask.
 */
export async function searchSerials(
  query: string,
  scope: WebSerialSearchScope,
  signal?: AbortSignal,
  refresh = false,
  phase?: 'index',
): Promise<WebSerialSearchResult> {
  const params = new URLSearchParams({ q: query, kind: scope })
  if (refresh) params.set('refresh', '1')
  if (phase) params.set('phase', phase)
  return apiJson(`${BASE}/search?${params.toString()}`, { signal }, 'webSerials.api.search')
}

export async function suggestSerials(query: string, signal?: AbortSignal): Promise<WebSerialSuggestResult> {
  const params = new URLSearchParams({ q: query, kind: 'novel' })
  return apiJson(`${BASE}/suggest?${params.toString()}`, { signal }, 'webSerials.api.suggest')
}

export async function discoverSerials(
  query: string,
  kind: WebSerialSearchScope,
  signal?: AbortSignal,
  refresh = false,
): Promise<WebSerialDiscoverResult> {
  const params = new URLSearchParams({ q: query, kind })
  if (refresh) params.set('refresh', '1')
  return apiJson(`${BASE}/discover?${params.toString()}`, { signal }, 'webSerials.api.search')
}

export async function fetchDiscoverEntry(kind: WebSerialKind, matchId: string, signal?: AbortSignal): Promise<WebSerialCatalogEntry> {
  return apiJson(`${BASE}/discover/${kind}/${encodeURIComponent(matchId)}`, { signal }, 'webSerials.api.search')
}

export async function fetchDiscoverSources(
  kind: WebSerialKind,
  matchId: string,
  signal?: AbortSignal,
  refresh = false,
): Promise<WebSerialSourceOptions> {
  return apiJson(
    `${BASE}/discover/${kind}/${encodeURIComponent(matchId)}/sources${refresh ? '?refresh=1' : ''}`,
    { signal },
    'webSerials.api.discoverSources',
  )
}

export async function resolveSerialUrl(input: ResolveWebSerialUrlInput, signal?: AbortSignal): Promise<WebSerialSeriesDetail> {
  return apiJson(`${BASE}/resolve`, { ...jsonBody('POST', input), signal }, 'webSerials.api.resolve')
}

function matchQuery(matchId: string | undefined): string {
  return matchId ? `?matchId=${encodeURIComponent(matchId)}` : ''
}

/** `matchId`: the series-database id the series was found for, so chapters already imported from other sources are recognised. */
export async function fetchSeries(seriesKey: string, matchId?: string, signal?: AbortSignal): Promise<WebSerialSeriesDetail> {
  return apiJson(`${BASE}/series/${encodeURIComponent(seriesKey)}${matchQuery(matchId)}`, signal ? { signal } : undefined, 'webSerials.api.series')
}

export async function fetchSeriesLookup(seriesKey: string, matchId?: string): Promise<WebSerialSeriesLookup> {
  return apiJson(`${BASE}/series/${encodeURIComponent(seriesKey)}/lookup${matchQuery(matchId)}`, undefined, 'webSerials.api.lookup')
}

export async function fetchSeriesSources(seriesKey: string, signal?: AbortSignal, refresh = false): Promise<WebSerialSourceOptions> {
  return apiJson(`${BASE}/series/${encodeURIComponent(seriesKey)}/sources${refresh ? '?refresh=1' : ''}`, { signal }, 'webSerials.api.otherSources')
}

export async function createSerialJob(input: CreateWebSerialJobInput): Promise<WebSerialJob> {
  return apiJson(`${BASE}/jobs`, jsonBody('POST', input), 'webSerials.api.createJob')
}

export async function fetchSerialJobs(scope: WebSerialJobScope = 'mine', limit = 50, offset = 0): Promise<WebSerialJobList> {
  return apiJson(`${BASE}/jobs?scope=${scope}&limit=${limit}&offset=${offset}`, undefined, 'webSerials.api.queue')
}

export async function fetchSerialJobDetail(id: number): Promise<WebSerialJobDetail> {
  return apiJson(`${BASE}/jobs/${id}`, undefined, 'webSerials.api.jobDetail')
}

export async function pauseSerialJob(id: number): Promise<WebSerialJob> {
  return apiJson(`${BASE}/jobs/${id}/pause`, { method: 'POST' }, 'webSerials.api.pauseJob')
}

export async function resumeSerialJob(id: number): Promise<WebSerialJob> {
  return apiJson(`${BASE}/jobs/${id}/resume`, { method: 'POST' }, 'webSerials.api.resumeJob')
}

export async function moveSerialJobToTop(id: number): Promise<WebSerialJob> {
  return apiJson(`${BASE}/jobs/${id}/move-to-top`, { method: 'POST' }, 'webSerials.api.moveJob')
}

export async function removeSerialJob(id: number): Promise<void> {
  await apiSend(`${BASE}/jobs/${id}`, { method: 'DELETE' }, 'webSerials.api.removeJob')
}

export async function clearFinishedSerialJobs(scope: WebSerialJobScope): Promise<WebSerialClearFinishedResult> {
  return apiJson(`${BASE}/jobs/clear-finished?scope=${scope}`, { method: 'POST' }, 'webSerials.api.clearFinished')
}

export async function retrySerialJobItem(jobId: number, itemId: number): Promise<WebSerialJobDetail> {
  return apiJson(`${BASE}/jobs/${jobId}/items/${itemId}/retry`, { method: 'POST' }, 'webSerials.api.retryItem')
}

export async function pauseSerialQueue(): Promise<{ queuePaused: boolean }> {
  return apiJson(`${BASE}/queue/pause`, { method: 'POST' }, 'webSerials.api.pauseQueue')
}

export async function resumeSerialQueue(): Promise<{ queuePaused: boolean }> {
  return apiJson(`${BASE}/queue/resume`, { method: 'POST' }, 'webSerials.api.resumeQueue')
}

export async function cancelSerialJob(id: number): Promise<WebSerialJob> {
  return apiJson(`${BASE}/jobs/${id}/cancel`, { method: 'POST' }, 'webSerials.api.cancelJob')
}

export async function retrySerialJob(id: number): Promise<WebSerialJob> {
  return apiJson(`${BASE}/jobs/${id}/retry`, { method: 'POST' }, 'webSerials.api.retryJob')
}

export async function fetchMoveCandidates(id: number, signal?: AbortSignal): Promise<WebSerialMoveCandidates> {
  return apiJson(`${BASE}/jobs/${id}/move-candidates`, { signal }, 'webSerials.api.otherSources')
}

export async function moveSerialJob(id: number, input: MoveWebSerialJobInput): Promise<MoveWebSerialJobResult> {
  return apiJson(`${BASE}/jobs/${id}/move`, jsonBody('POST', input), 'webSerials.api.moveJob')
}

export async function fetchWebSerialSettings(): Promise<WebSerialSettings> {
  return apiJson(`${BASE}/admin/settings`, undefined, 'webSerials.api.loadSettings')
}

export async function saveWebSerialSettings(input: UpdateWebSerialSettingsInput): Promise<WebSerialSettings> {
  return apiJson(`${BASE}/admin/settings`, jsonBody('PUT', input), 'webSerials.api.saveSettings')
}

export async function testWebSerialEngine(input: TestWebSerialEngineInput): Promise<WebSerialEngineHealth> {
  return apiJson(`${BASE}/admin/test`, jsonBody('POST', input), 'webSerials.api.testEngine')
}

export async function fetchNovelProviders(): Promise<WebSerialNovelProviders> {
  return apiJson(`${BASE}/novel-providers`, undefined, 'webSerials.api.novelProviders')
}

export async function saveNovelProviders(input: UpdateWebSerialNovelProvidersInput): Promise<WebSerialNovelProviders> {
  return apiJson(`${BASE}/novel-providers`, jsonBody('PUT', input), 'webSerials.api.saveNovelProviders')
}

export async function fetchNovelSources(): Promise<WebSerialNovelSource[]> {
  return apiJson(`${BASE}/admin/novel-sources`, undefined, 'webSerials.api.novelSources')
}

export async function fetchAvailableNovelSources(lang = 'English'): Promise<WebSerialNovelSourceEntry[]> {
  return apiJson(`${BASE}/admin/novel-source-catalog?lang=${encodeURIComponent(lang)}`, undefined, 'webSerials.api.availableNovelSources')
}

export async function fetchInstalledNovelSources(): Promise<WebSerialNovelSourceEntry[]> {
  return apiJson(`${BASE}/admin/novel-source-catalog/installed`, undefined, 'webSerials.api.installedNovelSources')
}

export async function runNovelSourceAction(id: string, action: 'install' | 'update' | 'remove'): Promise<void> {
  const path =
    action === 'remove'
      ? `${BASE}/admin/novel-source-catalog/${encodeURIComponent(id)}`
      : `${BASE}/admin/novel-source-catalog/${encodeURIComponent(id)}/${action}`
  await apiSend(path, { method: action === 'remove' ? 'DELETE' : 'POST' }, 'webSerials.api.novelSourceAction')
}

export async function fetchNovelIndexStatus(): Promise<WebSerialNovelIndexStatus> {
  return apiJson(`${BASE}/admin/novel-index`, undefined, 'webSerials.api.novelIndex')
}

export async function runNovelIndexAction(id: string, action: 'fill' | 'rebuild'): Promise<WebSerialNovelIndexStatus> {
  return apiJson(
    `${BASE}/admin/novel-index/${encodeURIComponent(id)}/${action}`,
    { method: 'POST' },
    action === 'fill' ? 'webSerials.api.fillIndex' : 'webSerials.api.rebuildIndex',
  )
}

export async function fetchMangaSources(): Promise<WebSerialMangaSource[]> {
  return apiJson(`${BASE}/admin/manga-sources`, undefined, 'webSerials.api.mangaSources')
}

export async function testLookup(): Promise<WebSerialLookupHealth> {
  return apiJson(`${BASE}/admin/lookup/test`, { method: 'POST' }, 'webSerials.api.testLookup')
}

export type WebSerialExtensionAction = 'install' | 'uninstall' | 'update'

export async function fetchMangaExtensions(query: WebSerialMangaExtensionQuery, signal?: AbortSignal): Promise<WebSerialMangaExtensionPage> {
  const params = new URLSearchParams()
  if (query.query) params.set('query', query.query)
  if (query.lang) params.set('lang', query.lang)
  if (query.installed !== undefined) params.set('installed', String(query.installed))
  if (query.adult !== undefined) params.set('adult', String(query.adult))
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  if (query.offset !== undefined) params.set('offset', String(query.offset))
  return apiJson(`${BASE}/admin/manga-extensions?${params.toString()}`, { signal }, 'webSerials.api.mangaExtensions')
}

export async function refreshMangaExtensions(): Promise<{ total: number }> {
  return apiJson(`${BASE}/admin/manga-extensions/refresh`, { method: 'POST' }, 'webSerials.api.refreshExtensions')
}

export async function runMangaExtensionAction(pkgName: string, action: WebSerialExtensionAction): Promise<WebSerialMangaExtension> {
  const fallback =
    action === 'install'
      ? 'webSerials.api.installExtension'
      : action === 'uninstall'
        ? 'webSerials.api.uninstallExtension'
        : 'webSerials.api.updateExtension'
  return apiJson(`${BASE}/admin/manga-extensions/${encodeURIComponent(pkgName)}/${action}`, { method: 'POST' }, fallback)
}

export async function fetchMangaRepos(): Promise<string[]> {
  return apiJson(`${BASE}/admin/manga-repos`, undefined, 'webSerials.api.repos')
}

export async function addMangaRepo(input: WebSerialExtensionRepoInput): Promise<void> {
  await apiSend(`${BASE}/admin/manga-repos`, jsonBody('POST', input), 'webSerials.api.addRepo')
}

export async function removeMangaRepo(url: string): Promise<void> {
  await apiSend(`${BASE}/admin/manga-repos?url=${encodeURIComponent(url)}`, { method: 'DELETE' }, 'webSerials.api.removeRepo')
}

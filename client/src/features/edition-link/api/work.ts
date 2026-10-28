import type {
  AbsHistoryRebuildPreview,
  AbsHistoryRebuildResult,
  EditionLinkMatchBucket,
  EditionLinkMatchDismissal,
  EditionLinkMatchListResponse,
  EditionLinkScanStatus,
  EditionLinkSettings,
  LinkAllStrongResult,
  WorkForBook,
} from '@bookorbit/types'

import { api } from '@/lib/api'

const BASE = '/api/v1/edition-links'

async function expectJson<T>(response: Response, fallbackMessage: string): Promise<T> {
  if (!response.ok) throw new Error(fallbackMessage)
  return response.json() as Promise<T>
}

async function expectOk(response: Response, fallbackMessage: string): Promise<void> {
  if (!response.ok) throw new Error(fallbackMessage)
}

function jsonRequest(method: string, body?: unknown): RequestInit {
  return body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

export async function getWorkForBook(bookId: number): Promise<WorkForBook> {
  return expectJson(await api(`${BASE}/work/${bookId}`), 'work_load_failed')
}

export async function addWorkMember(anchorBookId: number, bookId: number): Promise<void> {
  await expectOk(await api(`${BASE}/work/${anchorBookId}/members`, jsonRequest('POST', { bookId })), 'work_member_add_failed')
}

export async function removeWorkMember(bookId: number): Promise<void> {
  await expectOk(await api(`${BASE}/work/members/${bookId}`, jsonRequest('DELETE')), 'work_member_remove_failed')
}

export async function setWorkPrimary(bookId: number): Promise<void> {
  await expectOk(await api(`${BASE}/work/members/${bookId}/primary`, jsonRequest('POST')), 'work_primary_failed')
}

export async function getEditionLinkSettings(): Promise<EditionLinkSettings> {
  return expectJson(await api(`${BASE}/settings`), 'edition_link_settings_load_failed')
}

export async function updateEditionLinkSettings(patch: Partial<EditionLinkSettings>): Promise<EditionLinkSettings> {
  return expectJson(await api(`${BASE}/settings`, jsonRequest('PUT', patch)), 'edition_link_settings_save_failed')
}

export async function startMatchScan(): Promise<EditionLinkScanStatus> {
  return expectJson(await api(`${BASE}/matches/scans`, jsonRequest('POST')), 'edition_link_scan_start_failed')
}

export async function getActiveMatchScan(): Promise<EditionLinkScanStatus> {
  return expectJson(await api(`${BASE}/matches/scans/active`), 'edition_link_scan_status_failed')
}

export interface MatchListParams {
  /** One bucket, or several joined with a comma. */
  buckets?: EditionLinkMatchBucket[]
  page: number
  pageSize: number
  libraryId?: number
}

export async function getMatches(params: MatchListParams): Promise<EditionLinkMatchListResponse> {
  const query = new URLSearchParams({ page: String(params.page), pageSize: String(params.pageSize) })
  if (params.buckets && params.buckets.length > 0) query.set('bucket', params.buckets.join(','))
  if (params.libraryId !== undefined) query.set('libraryId', String(params.libraryId))
  return expectJson(await api(`${BASE}/matches?${query.toString()}`), 'edition_link_matches_failed')
}

export async function linkMatch(matchId: number): Promise<void> {
  await expectOk(await api(`${BASE}/matches/${matchId}/link`, jsonRequest('POST')), 'edition_link_match_link_failed')
}

export async function linkAllStrongMatches(): Promise<LinkAllStrongResult> {
  return expectJson(await api(`${BASE}/matches/link-all-strong`, jsonRequest('POST')), 'edition_link_link_all_failed')
}

export async function dismissMatch(matchId: number): Promise<void> {
  await expectOk(await api(`${BASE}/matches/${matchId}/dismiss`, jsonRequest('POST')), 'edition_link_match_dismiss_failed')
}

export async function getMatchDismissals(): Promise<EditionLinkMatchDismissal[]> {
  return expectJson(await api(`${BASE}/matches/dismissals`), 'edition_link_dismissals_failed')
}

export async function restoreMatchDismissal(bookIdA: number, bookIdB: number): Promise<void> {
  await expectOk(await api(`${BASE}/matches/dismissals/${bookIdA}/${bookIdB}`, jsonRequest('DELETE')), 'edition_link_restore_failed')
}

export async function unlinkEditionBook(bookId: number): Promise<void> {
  await expectOk(await api(`${BASE}/link/${bookId}`, jsonRequest('DELETE')), 'edition_link_unlink_failed')
}

export async function previewAbsHistoryRebuild(): Promise<AbsHistoryRebuildPreview> {
  return expectJson(await api(`${BASE}/audiobookshelf-history/preview`, jsonRequest('POST')), 'abs_history_preview_failed')
}

export async function rebuildAbsHistory(): Promise<AbsHistoryRebuildResult> {
  return expectJson(await api(`${BASE}/audiobookshelf-history/rebuild`, jsonRequest('POST')), 'abs_history_rebuild_failed')
}

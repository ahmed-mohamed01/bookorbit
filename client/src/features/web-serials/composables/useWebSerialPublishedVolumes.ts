import { computed, onScopeDispose, ref, unref, watch, type Ref } from 'vue'
import { i18n } from '@/i18n'
import { isCancellableBookRequestStatus, isGrabbableBookRequestStatus } from '@bookorbit/types'
import type {
  BookRequestItem,
  CreateBookRequestPayload,
  ReleaseCandidateItem,
  WebSerialCapabilities,
  WebSerialPublishedRequest,
} from '@bookorbit/types'
import { useRequestLanguageDefault } from '@/features/book-requests/composables/useRequestDestinationDefault'
import { useLibraries } from '@/features/library/composables/useLibraries'
import {
  cancelVolumeRequest,
  createVolumeRequest,
  fetchBookRequest,
  fetchPublishedRequests,
  fetchRequestReleases,
  fetchRequestSourceStatus,
  grabRequestRelease,
  recordPublishedRequest,
} from '../api/bookRequests'
import { fetchCapabilities } from '../api/webSerials'
import { messageOf } from '../lib/messageOf'
import { buildMatchedVolumeRequest, candidateTitle, type VolumeCandidatePick } from '../lib/publishedVolumeMatch'
import {
  buildVolumeRequest,
  buildVolumeRows,
  clampVolumeCount,
  isFreeTextRequest,
  isVolumeMissing,
  resolveVolumeCount,
  type PublishedSeries,
  type PublishedVolumeDestination,
  type PublishedVolumeRow,
} from '../lib/publishedVolumes'
import { useWebSerialVolumeMatch } from './useWebSerialVolumeMatch'

/** Request statuses are read one id at a time; a few at once keeps a long series quick without flooding the server. */
const STATUS_CONCURRENCY = 4

/** The ranked list is long; the best few are what an approver picks from inline. The Requests page has the rest. */
export const INLINE_RELEASE_LIMIT = 10

export interface PublishedVolumeAccess {
  /** Holds `book_request_access`. */
  canRequest: Ref<boolean>
  /** Holds `manage_book_requests`, which gates release search and grab. */
  canManage: Ref<boolean>
  /** The series is licensed, or no source carries it. */
  offered: Ref<boolean>
  /** The signed-in user. A re-match cancels the old request, which only its requester may do. */
  userId: Ref<number | null>
}

export interface VolumeReleases {
  state: 'loading' | 'ready' | 'error'
  releases: ReleaseCandidateItem[]
  total: number
  error: string | null
}

/** What the provider search concluded about one volume, so the row can say what would be requested. */
export type VolumeMatchState = { state: 'searching' } | { state: 'matched'; title: string } | { state: 'none' }

/** A re-match that found a book and is waiting to be confirmed before it replaces the request. */
export interface VolumeRematch {
  volume: number
  request: BookRequestItem
  /** The published book the volume matched, shown in the confirm. */
  title: string
  payload: CreateBookRequestPayload
}

export function useWebSerialPublishedVolumes(series: Ref<PublishedSeries | null>, access: PublishedVolumeAccess) {
  const { libraries, fetchLibraries } = useLibraries()
  const { load: loadLanguageDefault, resolveLanguage } = useRequestLanguageDefault()
  const match = useWebSerialVolumeMatch()
  const configured = ref<boolean | null>(null)
  const capabilities = ref<WebSerialCapabilities | null>(null)
  const listState = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const listError = ref<string | null>(null)
  const requests = ref(new Map<number, BookRequestItem>())
  const typedCount = ref<number | null>(null)
  const pending = ref(new Set<number>())
  const errors = ref<Record<number, string>>({})
  const bulk = ref<{ done: number; total: number } | null>(null)
  const releases = ref<Record<number, VolumeReleases>>({})
  const grabbing = ref<string | null>(null)
  const matches = ref<Record<number, VolumeMatchState>>({})
  const rematch = ref<VolumeRematch | null>(null)
  const rematchBusy = ref(false)
  const requestLanguage = ref<string | null>(null)
  const stopping = ref(false)
  let token = 0

  const visible = computed(() => access.canRequest.value && access.offered.value && series.value !== null && configured.value === true)
  const knownCount = computed(() => series.value?.publication?.finalVolume ?? null)
  const count = computed(() => resolveVolumeCount(series.value?.publication ?? null, typedCount.value))
  const rows = computed<PublishedVolumeRow[]>(() => buildVolumeRows(count.value, requests.value))
  const missing = computed(() => rows.value.filter(isVolumeMissing))
  const destination = computed<PublishedVolumeDestination>(() => {
    const kind = series.value?.kind
    const entry = kind ? capabilities.value?.[kind] : undefined
    const libraryId = entry?.defaultLibraryId ?? null
    const library = libraryId === null ? undefined : libraries.value.find((candidate) => candidate.id === libraryId)
    return { libraryId, folderId: entry?.targetFolderId ?? null, allowedFormats: library?.allowedFormats ?? [] }
  })

  async function checkConfigured(): Promise<void> {
    if (configured.value !== null) return
    try {
      const status = await fetchRequestSourceStatus()
      configured.value = status.enabled > 0
    } catch {
      configured.value = false
    }
  }

  async function loadDestination(): Promise<void> {
    try {
      const [value] = await Promise.all([fetchCapabilities(), fetchLibraries()])
      capabilities.value = value
    } catch {
      capabilities.value = null
    }
    // The language a matched request asks for is decided the way the Requests page decides it, not
    // taken from the edition the provider happened to return.
    await loadLanguageDefault()
    requestLanguage.value = resolveLanguage(unref(i18n.global.locale))
  }

  async function fetchStatuses(recorded: WebSerialPublishedRequest[]): Promise<Map<number, BookRequestItem>> {
    const found = new Map<number, BookRequestItem>()
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < recorded.length) {
        const entry = recorded[next++]!
        const volume = Number(entry.volume)
        const request = await fetchBookRequest(entry.bookRequestId)
        if (request && Number.isInteger(volume)) found.set(volume, request)
      }
    }
    await Promise.all(Array.from({ length: Math.min(STATUS_CONCURRENCY, recorded.length) }, worker))
    return found
  }

  async function loadRequests(): Promise<void> {
    const current = series.value
    const mine = ++token
    if (!current) return
    listState.value = 'loading'
    listError.value = null
    try {
      const recorded = await fetchPublishedRequests(current.kind, current.matchId)
      const found = await fetchStatuses(recorded)
      if (mine !== token) return
      requests.value = found
      listState.value = 'ready'
    } catch (cause) {
      if (mine !== token) return
      listError.value = messageOf(cause, 'webSerials.api.requests')
      listState.value = 'error'
    }
  }

  function reset(): void {
    token += 1
    requests.value = new Map()
    typedCount.value = null
    pending.value = new Set()
    errors.value = {}
    bulk.value = null
    stopping.value = false
    releases.value = {}
    matches.value = {}
    rematch.value = null
    rematchBusy.value = false
    listState.value = 'idle'
  }

  watch(
    () => [access.canRequest.value && access.offered.value, series.value?.kind, series.value?.title] as const,
    async ([wanted], previous) => {
      if (previous && (previous[1] !== series.value?.kind || previous[2] !== series.value?.title)) reset()
      if (!wanted || !series.value) return
      await checkConfigured()
      if (!visible.value) return
      void loadDestination()
      if (listState.value === 'idle') await loadRequests()
    },
    { immediate: true },
  )

  function setTypedCount(value: number | null): void {
    typedCount.value = value === null ? null : clampVolumeCount(value)
  }

  function setRequest(volume: number, request: BookRequestItem): void {
    requests.value = new Map(requests.value).set(volume, request)
  }

  function setError(volume: number, message: string | null): void {
    const next = { ...errors.value }
    if (message === null) delete next[volume]
    else next[volume] = message
    errors.value = next
  }

  function setMatch(volume: number, value: VolumeMatchState | null): void {
    const next = { ...matches.value }
    if (value === null) delete next[volume]
    else next[volume] = value
    matches.value = next
  }

  async function recordRequest(current: PublishedSeries, volume: number, bookRequestId: number): Promise<void> {
    try {
      await recordPublishedRequest({ kind: current.kind, matchId: current.matchId, volume: String(volume), bookRequestId })
    } catch {
      // The request exists either way; only its status after a reload depends on this record.
    }
  }

  /** Once the request exists it is recorded against the series it was made for, even if the sheet closed or moved on meanwhile. */
  async function createAndRecord(current: PublishedSeries, volume: number, payload: CreateBookRequestPayload, mine: number): Promise<boolean> {
    const result = await createVolumeRequest(payload)
    if (mine === token) setRequest(volume, result.request)
    await recordRequest(current, volume, result.request.id)
    return mine === token
  }

  function matchedPayload(current: PublishedSeries, volume: number, pick: VolumeCandidatePick): CreateBookRequestPayload {
    return buildMatchedVolumeRequest(pick.candidate, {
      series: current,
      volume,
      destination: destination.value,
      language: requestLanguage.value,
      accepted: pick.accepted,
      providerLabel: match.providerLabel,
    })
  }

  /** Read at the moment of asking: a bulk run's list was taken up front, and a row may have been requested since. */
  function stillMissing(volume: number): boolean {
    return isVolumeMissing({ volume, request: requests.value.get(volume) ?? null })
  }

  /** Resolve the volume to a published book, then request that book. No match means no request. */
  async function requestVolume(volume: number): Promise<boolean> {
    const current = series.value
    if (!current || pending.value.has(volume) || !stillMissing(volume)) return false
    const mine = token
    pending.value = new Set(pending.value).add(volume)
    setError(volume, null)
    setMatch(volume, { state: 'searching' })
    try {
      const pick = await match.resolveVolume(current, volume)
      if (mine !== token) return false
      if (!pick) {
        setMatch(volume, { state: 'none' })
        return false
      }
      setMatch(volume, { state: 'matched', title: candidateTitle(pick.candidate) })
      return await createAndRecord(current, volume, matchedPayload(current, volume, pick), mine)
    } catch (cause) {
      if (mine === token) {
        setError(volume, messageOf(cause, 'webSerials.api.requestVolume'))
        setMatch(volume, null)
      }
      return false
    } finally {
      if (mine === token) {
        const next = new Set(pending.value)
        next.delete(volume)
        pending.value = next
      }
    }
  }

  /** The free-text request of a volume the providers could not identify, on the requester's say so. */
  async function requestVolumeAnyway(volume: number): Promise<boolean> {
    const current = series.value
    if (!current || pending.value.has(volume) || !stillMissing(volume)) return false
    const mine = token
    pending.value = new Set(pending.value).add(volume)
    setError(volume, null)
    try {
      const done = await createAndRecord(current, volume, buildVolumeRequest(current, volume, destination.value), mine)
      if (done) setMatch(volume, null)
      return done
    } catch (cause) {
      if (mine === token) setError(volume, messageOf(cause, 'webSerials.api.requestVolume'))
      return false
    } finally {
      if (mine === token) {
        const next = new Set(pending.value)
        next.delete(volume)
        pending.value = next
      }
    }
  }

  /** One at a time, in volume order, so the approver queue fills in order and one refusal never stops the rest. */
  async function requestAllMissing(): Promise<void> {
    if (bulk.value) return
    const volumes = missing.value.map((row) => row.volume)
    if (volumes.length === 0) return
    const mine = token
    bulk.value = { done: 0, total: volumes.length }
    stopping.value = false
    try {
      for (const volume of volumes) {
        if (mine !== token || stopping.value) return
        await requestVolume(volume)
        if (mine !== token) return
        bulk.value = { done: bulk.value.done + 1, total: volumes.length }
      }
    } finally {
      if (mine === token) {
        bulk.value = null
        stopping.value = false
      }
    }
  }

  /** The volume being asked for finishes; the run stops before the next one. */
  function stopRequestAll(): void {
    if (bulk.value) stopping.value = true
  }

  /**
   * Re-match a request that was built from free text. Book Requests has no route that rewrites a
   * request's work, so the found book is held for a confirm that cancels the old row and asks for it.
   */
  async function rematchVolume(volume: number): Promise<void> {
    const current = series.value
    const request = requests.value.get(volume) ?? null
    if (!current || !canRematch(request) || pending.value.has(volume)) return
    const mine = token
    pending.value = new Set(pending.value).add(volume)
    setError(volume, null)
    setMatch(volume, { state: 'searching' })
    try {
      const pick = await match.resolveVolume(current, volume)
      if (mine !== token) return
      if (!pick) {
        setMatch(volume, { state: 'none' })
        return
      }
      const title = candidateTitle(pick.candidate)
      setMatch(volume, { state: 'matched', title })
      rematch.value = { volume, request, title, payload: matchedPayload(current, volume, pick) }
    } catch (cause) {
      if (mine === token) {
        setError(volume, messageOf(cause, 'webSerials.api.matchVolume'))
        setMatch(volume, null)
      }
    } finally {
      if (mine === token) {
        const next = new Set(pending.value)
        next.delete(volume)
        pending.value = next
      }
    }
  }

  async function confirmRematch(): Promise<void> {
    const held = rematch.value
    const current = series.value
    if (!held || !current || rematchBusy.value) return
    const mine = token
    rematchBusy.value = true
    try {
      // The old request is gone once cancelled, so the confirmed replacement is asked for and recorded even if the sheet closed.
      const cancelled = await cancelVolumeRequest(held.request.id)
      // The row shows the cancellation before the replacement exists, so a refusal leaves it saying what it is.
      if (mine === token) setRequest(held.volume, cancelled)
      const result = await createVolumeRequest(held.payload)
      if (mine === token) setRequest(held.volume, result.request)
      await recordRequest(current, held.volume, result.request.id)
    } catch (cause) {
      if (mine === token) setError(held.volume, messageOf(cause, 'webSerials.api.requestMatched'))
    } finally {
      if (mine === token) {
        rematchBusy.value = false
        rematch.value = null
      }
    }
  }

  // Work still running when the section goes away must not write to it or keep requesting volumes.
  onScopeDispose(() => {
    token += 1
  })

  function cancelRematch(): void {
    if (!rematchBusy.value) rematch.value = null
  }

  /** A free-text request the caller made and can still cancel, since confirming a re-match cancels it. */
  function canRematch(request: BookRequestItem | null): request is BookRequestItem {
    return (
      isFreeTextRequest(request) &&
      isCancellableBookRequestStatus(request.status) &&
      access.userId.value !== null &&
      request.userId === access.userId.value
    )
  }

  function canFindReleases(request: BookRequestItem | null): boolean {
    return access.canManage.value && request !== null && isGrabbableBookRequestStatus(request.status)
  }

  function setReleases(requestId: number, value: VolumeReleases | null): void {
    const next = { ...releases.value }
    if (value === null) delete next[requestId]
    else next[requestId] = value
    releases.value = next
  }

  async function findReleases(request: BookRequestItem): Promise<void> {
    if (!canFindReleases(request)) return
    const mine = token
    setReleases(request.id, { state: 'loading', releases: [], total: 0, error: null })
    try {
      const result = await fetchRequestReleases(request.id)
      if (mine !== token) return
      setReleases(request.id, {
        state: 'ready',
        releases: result.releases.slice(0, INLINE_RELEASE_LIMIT),
        total: result.releases.length,
        error: null,
      })
    } catch (cause) {
      if (mine !== token) return
      setReleases(request.id, { state: 'error', releases: [], total: 0, error: messageOf(cause, 'webSerials.api.releases') })
    }
  }

  function closeReleases(request: BookRequestItem): void {
    setReleases(request.id, null)
  }

  async function grab(volume: number, request: BookRequestItem, release: ReleaseCandidateItem): Promise<boolean> {
    if (grabbing.value !== null || !canFindReleases(request)) return false
    const mine = token
    grabbing.value = release.guid
    setError(volume, null)
    try {
      const updated = await grabRequestRelease(request.id, release.indexerId, release.guid)
      if (mine !== token) return false
      setRequest(volume, updated)
      setReleases(request.id, null)
      return true
    } catch (cause) {
      if (mine === token) setError(volume, messageOf(cause, 'webSerials.api.grab'))
      return false
    } finally {
      if (mine === token) grabbing.value = null
    }
  }

  return {
    visible,
    configured,
    knownCount,
    count,
    rows,
    missing,
    listState,
    listError,
    pending,
    errors,
    bulk,
    stopping,
    releases,
    grabbing,
    matches,
    rematch,
    rematchBusy,
    destination,
    setTypedCount,
    loadRequests,
    requestVolume,
    requestVolumeAnyway,
    requestAllMissing,
    stopRequestAll,
    rematchVolume,
    confirmRematch,
    cancelRematch,
    canRematch,
    canFindReleases,
    findReleases,
    closeReleases,
    grab,
  }
}

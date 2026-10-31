import { computed, onScopeDispose, ref, toValue, watch, type MaybeRefOrGetter, type Ref } from 'vue'
import { parseReleaseVolumes, releaseNamesSeries } from '@bookorbit/types'
import type {
  ReleaseCandidateItem,
  ReleaseFileInspection,
  ReleaseSearchProgress,
  StreamBookRequestReleasesPayload,
  WebSerialDraft,
  WebSerialPrintState,
  WebSerialPrintSuggestion,
  WebSerialViewerRole,
} from '@bookorbit/types'
import { api } from '@/lib/api'
import { apiError } from '@/lib/api-json'
import { streamReleaseSearch } from '@/features/book-requests/api/streamReleaseSearch'
import { fulfilmentBase } from '@/features/book-requests/fulfilmentBase'
import { useDownloadClientSummaries } from '@/features/book-requests/composables/useDownloadClients'
import {
  closePrintDraft,
  createPrintDraft,
  downloadPrintVolumes,
  fetchPrintState,
  fetchPrintSuggestion,
  requestPrintVolumes,
} from '../api/webSerials'
import { cancelVolumeRequest } from '../api/bookRequests'
import { countVolumes, offFormatKind, preselectMissingUnits, releaseKey, unitVolumes } from '../lib/lnAcquisition'
import { resolveVolumeCount, type PublishedSeries } from '../lib/publishedVolumes'

export function useLightNovelAcquisition(
  series: Ref<PublishedSeries | null>,
  access: { role: MaybeRefOrGetter<WebSerialViewerRole>; canManage: MaybeRefOrGetter<boolean> },
) {
  const query = ref({ title: '', author: '' })
  const state = ref<WebSerialPrintState | null>(null)
  const error = ref<unknown>(null)
  const volumeFilter = ref(new Set<number>())
  const results = ref<ReleaseCandidateItem[]>([])
  const status = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const indexers = ref<ReleaseSearchProgress['indexers']>([])
  const pending = ref<ReleaseSearchProgress['pending']>([])
  const suggestion = ref<WebSerialPrintSuggestion | null>(null)
  const picks = ref(new Set<string>())
  const fileSelection = ref(new Map<string, Set<number>>())
  const inspections = ref(new Map<string, ReleaseFileInspection>())
  const inspecting = ref(new Set<string>())
  const inspectionErrors = ref(new Map<string, unknown>())
  const clientId = ref<number | null>(null)
  const sending = ref(false)
  const typedCount = ref<number | null>(null)
  const { clients: allClients, fetchClients } = useDownloadClientSummaries(() => toValue(access.canManage))
  const clients = computed(() => allClients.value.filter((client) => client.delivery === 'torrent'))
  function isTorrent(release: ReleaseCandidateItem) {
    return (indexers.value.find((indexer) => indexer.indexerId === release.indexerId)?.delivery ?? 'torrent') === 'torrent'
  }
  let draft: (WebSerialDraft & { matchId: string }) | null = null
  let searchGeneration = 0
  let sent = false
  let generation = 0
  const closed = ref(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | undefined
  const inspectionPromises = new Map<string, Promise<ReleaseFileInspection | null>>()
  const input = computed(() => {
    const current = series.value
    const volumeCount = resolveVolumeCount(current?.publication ?? null, typedCount.value)
    return current && volumeCount
      ? { title: current.title, altTitles: (current.altTitles ?? []).slice(0, 10), authors: current.authors, url: current.url, volumeCount }
      : null
  })
  function releaseVolumes(title: string): number[] | null {
    const current = input.value
    return current && releaseNamesSeries(title, [current.title, ...current.altTitles]) ? parseReleaseVolumes(title, current.volumeCount) : null
  }
  const counts = computed(() => countVolumes(state.value?.volumes ?? []))
  const downloads = computed(() => state.value?.downloads ?? [])
  const approver = () => toValue(access.role) === 'approver'
  function closeDraft() {
    closed.value = true
    generation++
    controller?.abort()
    clearTimeout(timer)
    const current = draft
    draft = null
    if (current && !sending.value && !sent) void closePrintDraft(current.matchId, current.seriesRequestId).catch(() => {})
  }
  function schedulePoll() {
    clearTimeout(timer)
    if (!closed.value && downloads.value.some((download) => !['filed', 'failed', 'held'].includes(download.status))) {
      timer = setTimeout(() => {
        void refresh()
      }, 5000)
    }
  }
  async function refresh() {
    const current = series.value
    const body = input.value
    const token = generation
    if (closed.value || !current || !body) return
    try {
      const next = await fetchPrintState(current.matchId, body)
      if (closed.value || token !== generation) return
      state.value = next
    } catch (cause) {
      if (token === generation) error.value = cause
    }
    if (token === generation) schedulePoll()
  }
  const requesting = ref(false)
  async function requestVolumes(volumes: number[]) {
    const current = series.value
    const body = input.value
    if (!current || !body || requesting.value || approver() || closed.value) return
    const token = generation
    requesting.value = true
    try {
      const next = await requestPrintVolumes(current.matchId, { ...body, volumes })
      if (token === generation && !closed.value) {
        state.value = next
        clearFilter()
      }
    } catch (cause) {
      if (token === generation) error.value = cause
    } finally {
      if (token === generation) requesting.value = false
    }
  }
  async function cancelRequest() {
    const id = state.value?.bookRequestId
    if (id == null || requesting.value || approver() || closed.value) return
    const token = generation
    requesting.value = true
    try {
      await cancelVolumeRequest(id)
      if (token === generation && !closed.value) await refresh()
    } catch (cause) {
      if (token === generation) error.value = cause
    } finally {
      if (token === generation) requesting.value = false
    }
  }
  function toggleVolume(volume: number) {
    if (volumeFilter.value.has(volume)) volumeFilter.value.delete(volume)
    else volumeFilter.value.add(volume)
  }
  function showMissingOnly() {
    volumeFilter.value = new Set(state.value?.volumes.filter((volume) => volume.state === 'missing').map((volume) => volume.volume))
  }
  function clearFilter() {
    volumeFilter.value = new Set()
  }
  const releases = computed(() =>
    results.value
      .map((release) => ({ ...release, kind: offFormatKind(release), volumes: releaseVolumes(release.title) ?? [] }))
      .filter((release) => !volumeFilter.value.size || release.volumes.some((volume) => volumeFilter.value.has(volume)))
      .sort((a, b) => Number(a.kind !== null) - Number(b.kind !== null) || b.score - a.score),
  )
  const plannedVolumes = computed(() => {
    const planned = new Map<string, number[]>()
    for (const release of results.value) {
      const key = releaseKey(release)
      const inspection = inspections.value.get(key)
      const volumes =
        inspection && inspection.unitCount > 1
          ? (inspection.selection?.units ?? [])
              .filter((unit) => fileSelection.value.get(key)?.has(unit.index))
              .flatMap((unit) => unitVolumes(unit, input.value?.volumeCount ?? 0))
          : (releaseVolumes(release.title) ?? [])
      planned.set(
        key,
        [...new Set(volumes)].sort((a, b) => a - b),
      )
    }
    return planned
  })
  const selected = computed(() =>
    results.value.filter((release) => {
      const key = releaseKey(release)
      const inspection = inspections.value.get(key)
      return (
        picks.value.has(key) &&
        !!inspection &&
        ((inspection.unitCount === 1 && plannedVolumes.value.get(key)?.length === 1) ||
          (inspection.unitCount > 1 && !!fileSelection.value.get(key)?.size))
      )
    }),
  )
  function isPack(release: ReleaseCandidateItem) {
    return (inspections.value.get(releaseKey(release))?.unitCount ?? 0) > 1
  }
  const hasPackPicks = computed(() => selected.value.some(isPack))
  const needsClient = computed(() => hasPackPicks.value || selected.value.some(isTorrent))
  const bar = computed(() => {
    const volumes = [...new Set(selected.value.flatMap((release) => plannedVolumes.value.get(releaseKey(release)) ?? []))]
    const client = clients.value.find((item) => item.id === clientId.value)
    return {
      volumes,
      volumeCount: volumes.length,
      releaseCount: selected.value.length,
      sizeBytes: selected.value.reduce((sum, release) => sum + (release.sizeBytes ?? 0), 0),
      canSend:
        approver() &&
        !closed.value &&
        !sending.value &&
        ![...picks.value].some((key) => inspecting.value.has(key)) &&
        !!draft &&
        (!needsClient.value || (!!client && (!hasPackPicks.value || client.fileSelection))) &&
        selected.value.length > 0 &&
        selected.value.length <= 50 &&
        selected.value.every((release) => !!plannedVolumes.value.get(releaseKey(release))?.length),
    }
  })
  function togglePick(release: ReleaseCandidateItem) {
    const key = releaseKey(release)
    if (picks.value.has(key)) picks.value.delete(key)
    else {
      picks.value.add(key)
      void inspect(release)
    }
  }
  function pickSuggestion() {
    picks.value = new Set(suggestion.value?.releases.map(releaseKey) ?? [])
    for (const release of suggestion.value?.releases ?? []) void inspect(release)
  }
  async function inspect(release: Pick<ReleaseCandidateItem, 'indexerId' | 'guid'>): Promise<ReleaseFileInspection | null> {
    const key = releaseKey(release)
    if (inspections.value.has(key)) {
      const inspection = inspections.value.get(key)!
      if (inspection.unitCount === 0 || (inspection.unitCount === 1 && plannedVolumes.value.get(key)?.length !== 1)) picks.value.delete(key)
      return inspection
    }
    if (inspectionPromises.has(key)) return inspectionPromises.get(key)!
    const current = draft
    const token = generation
    if (closed.value || !current || !approver()) return null
    const searchToken = searchGeneration
    inspecting.value.add(key)
    inspectionErrors.value.delete(key)
    const operation = (async () => {
      try {
        const response = await api(`${fulfilmentBase(toValue(access.canManage))}/${current.bookRequestId}/releases/inspect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ indexerId: release.indexerId, releaseGuid: release.guid }),
          signal: controller?.signal,
        })
        if (!response.ok) throw await apiError(response, 'webSerials.api.releases')
        const inspection = (await response.json()) as ReleaseFileInspection
        if (closed.value || token !== generation || searchToken !== searchGeneration) return null
        inspections.value.set(key, inspection)
        const releaseTitle = results.value.find((item) => releaseKey(item) === key)?.title ?? ''
        if (inspection.unitCount === 0 || (inspection.unitCount === 1 && (releaseVolumes(releaseTitle)?.length ?? 0) !== 1)) {
          picks.value.delete(key)
          inspectionErrors.value.set(key, new Error('This release cannot be downloaded as one volume'))
        }
        if (inspection.unitCount > 1)
          fileSelection.value.set(key, preselectMissingUnits(inspection.selection?.units ?? [], state.value?.volumes ?? []))
        return inspection
      } catch (cause) {
        if (token === generation && searchToken === searchGeneration) {
          error.value = cause
          inspectionErrors.value.set(key, cause)
        }
        return null
      } finally {
        if (token === generation && searchToken === searchGeneration) {
          inspectionPromises.delete(key)
          inspecting.value.delete(key)
        }
      }
    })()
    inspectionPromises.set(key, operation)
    return operation
  }
  async function searchWith(next: { title: string; author: string }) {
    await run(next)
  }
  async function run(next = query.value, fallbackAuthor = '') {
    const current = draft
    const body = input.value
    const token = generation
    if (closed.value || !approver() || !current || !body || status.value === 'loading') return
    searchGeneration++
    inspectionPromises.clear()
    inspections.value.clear()
    inspecting.value.clear()
    inspectionErrors.value.clear()
    query.value = { title: next.title.trim(), author: next.author.trim() }
    picks.value.clear()
    fileSelection.value.clear()
    suggestion.value = null
    results.value = []
    indexers.value = []
    pending.value = []
    error.value = null
    status.value = 'loading'
    try {
      const searchQuery = async () => {
        const payload: StreamBookRequestReleasesPayload = {
          overrides: { title: query.value.title, authors: query.value.author ? [query.value.author] : [] },
        }
        return streamReleaseSearch(
          `${fulfilmentBase(toValue(access.canManage))}/${current.bookRequestId}/releases/stream`,
          payload,
          (progress) => {
            if (token !== generation || closed.value) return
            results.value = progress.releases
            indexers.value = progress.indexers
            pending.value = progress.pending
          },
          controller?.signal,
        )
      }
      let result = await searchQuery()
      if (token !== generation || closed.value) return
      if (!result.releases.length && fallbackAuthor) {
        query.value = { ...query.value, author: fallbackAuthor }
        result = await searchQuery()
        if (token !== generation || closed.value) return
      }
      results.value = result.releases
      indexers.value = result.indexers
      pending.value = []
      const nextSuggestion = await fetchPrintSuggestion(current.matchId, {
        query: { title: query.value.title, authors: query.value.author ? [query.value.author] : [] },
        title: body.title,
        altTitles: body.altTitles,
        volumeCount: body.volumeCount,
        seriesRequestId: current.seriesRequestId,
      })
      if (token !== generation || closed.value) return
      suggestion.value = nextSuggestion
      status.value = 'ready'
      await refresh()
    } catch (cause) {
      if (token === generation && !closed.value) {
        error.value = cause
        status.value = 'error'
      }
    }
  }
  async function send() {
    if (!bar.value.canSend || !draft || !input.value) return
    const token = generation
    sending.value = true
    try {
      const next = await downloadPrintVolumes(draft.matchId, {
        title: input.value.title,
        altTitles: input.value.altTitles,
        volumeCount: input.value.volumeCount,
        seriesRequestId: draft.seriesRequestId,
        ...(clientId.value != null ? { downloadClientId: clientId.value } : {}),
        picks: selected.value.map((release) => {
          const key = releaseKey(release)
          return {
            downloadClientId: isTorrent(release) || isPack(release) ? clientId.value : null,
            indexerId: release.indexerId,
            releaseGuid: release.guid,
            unitIndexes: isPack(release) ? [...fileSelection.value.get(key)!].sort((a, b) => a - b) : null,
            volumes: plannedVolumes.value.get(key)!,
          }
        }),
      })
      if (token !== generation || closed.value) return
      sent = true
      for (const failure of next.failures ?? []) inspectionErrors.value.set(`${failure.indexerId}:${failure.releaseGuid}`, new Error(failure.error))
      picks.value.clear()
      await refresh()
    } catch (cause) {
      if (token === generation) error.value = cause
    } finally {
      if (token === generation) sending.value = false
    }
  }
  watch(
    () => JSON.stringify([series.value?.matchId, input.value, toValue(access.role), toValue(access.canManage)]),
    async () => {
      closeDraft()
      closed.value = false
      sent = false
      const token = generation
      controller = new AbortController()
      state.value = null
      results.value = []
      suggestion.value = null
      picks.value.clear()
      fileSelection.value.clear()
      inspections.value.clear()
      inspectionPromises.clear()
      inspecting.value.clear()
      inspectionErrors.value.clear()
      indexers.value = []
      pending.value = []
      requesting.value = false
      status.value = 'idle'
      sending.value = false
      error.value = null
      clearFilter()
      const current = series.value
      const body = input.value
      if (!current || !body) return
      try {
        if (approver()) {
          const created = await createPrintDraft(current.matchId, body)
          if (closed.value || token !== generation) {
            void closePrintDraft(current.matchId, created.seriesRequestId).catch(() => {})
            return
          }
          draft = { ...created, matchId: current.matchId }
          const initialState = refresh()
          await fetchClients()
          if (closed.value || token !== generation) return
          clientId.value = (clients.value.find((client) => client.fileSelection) ?? clients.value[0])?.id ?? null
          await Promise.all([initialState, run({ title: body.title.split(/:\s/)[0]!, author: '' }, body.authors[0] ?? '')])
        } else await refresh()
      } catch (cause) {
        if (token === generation) {
          error.value = cause
          status.value = 'error'
        }
      }
    },
    { immediate: true },
  )
  onScopeDispose(closeDraft)
  return {
    state,
    query,
    searchWith,
    requesting,
    requestVolumes,
    cancelRequest,
    counts,
    volumeFilter,
    toggleVolume,
    showMissingOnly,
    clearFilter,
    search: { status, indexers, pending, results, run },
    suggestion,
    pickSuggestion,
    releases,
    picks,
    togglePick,
    fileSelection,
    inspect,
    inspections,
    inspecting,
    inspectionErrors,
    selected,
    plannedVolumes,
    bar,
    clients,
    needsClient,
    clientId,
    send,
    downloads,
    closeDraft,
    refresh,
    error,
    sending,
    typedCount,
  }
}

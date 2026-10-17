import { computed, onScopeDispose, ref, watch, type Ref } from 'vue'
import type { HardcoverSearchBook, MonitoredAuthorSearchResult, WebSerialCatalogEntry } from '@bookorbit/types'
import { searchHardcoverUniversal } from '@/features/monitored/api/monitored'
import { discoverSerials } from '@/features/web-serials/api/webSerials'
import type { PaletteTab } from './useCommandPaletteResults'

export const EXTERNAL_DELAY_MS = 500
export const EXTERNAL_MIN_QUERY = 3
/** Fewer distinct strong local matches than this, and the external tier runs on its own. */
export const STRONG_MATCH_TARGET = 3
type MemberState = 'idle' | 'waiting' | 'loading' | 'done'

export function useExternalSearch(options: {
  query: Ref<string>
  tab: Ref<PaletteTab>
  isOpen: Ref<boolean>
  hardcoverPermission: Ref<boolean>
  mangaSearchable: Ref<boolean>
  novelsSearchable: Ref<boolean>
  capabilitiesReady: () => Promise<void>
  localReady: Ref<boolean>
  strongMatches: Ref<number>
}) {
  const { query, tab, isOpen } = options
  const manga = ref<WebSerialCatalogEntry[]>([])
  const novelEntries = ref<WebSerialCatalogEntry[]>([])
  const hardcoverBooks = ref<HardcoverSearchBook[]>([])
  const hardcoverAuthors = ref<MonitoredAuthorSearchResult[]>([])
  const hardcoverState = ref<MemberState>('idle')
  const mangaState = ref<MemberState>('idle')
  const novelState = ref<MemberState>('idle')
  const unavailable = ref(false)
  const longEnough = computed(() => query.value.length >= EXTERNAL_MIN_QUERY)
  const hardcoverAllowed = computed(() => options.hardcoverPermission.value && longEnough.value && !unavailable.value)
  const mangaAllowed = computed(() => options.mangaSearchable.value && longEnough.value)
  const externalNovelsAllowed = computed(() => options.novelsSearchable.value && longEnough.value)
  const members = {
    hardcover: {
      allowed: hardcoverAllowed,
      state: hardcoverState,
      items: computed(() => ({ books: hardcoverBooks.value, authors: hardcoverAuthors.value })),
    },
    manga: { allowed: mangaAllowed, state: mangaState, items: manga },
    novels: { allowed: externalNovelsAllowed, state: novelState, items: novelEntries },
  }
  const memberList = Object.values(members)
  const serialMembers = { manga: members.manga, novel: members.novels }
  const anyLoading = computed(() => memberList.some((member) => member.allowed.value && member.state.value === 'loading'))
  const anyIdle = computed(() => memberList.some((member) => member.allowed.value && member.state.value === 'idle'))
  let externalTimer: ReturnType<typeof setTimeout> | undefined
  let externalController: AbortController | undefined
  let externalGeneration = 0

  function resetExternal() {
    clearTimeout(externalTimer)
    externalController?.abort()
    externalController = undefined
    externalGeneration++
    for (const member of memberList) member.state.value = 'idle'
    manga.value = []
    novelEntries.value = []
    hardcoverBooks.value = []
    hardcoverAuthors.value = []
  }

  async function searchExternal() {
    const generation = externalGeneration
    await options.capabilitiesReady()
    if (!isOpen.value || generation !== externalGeneration) return
    clearTimeout(externalTimer)
    const controller = externalController ?? new AbortController()
    externalController = controller
    const q = query.value
    const current = () => generation === externalGeneration && !controller.signal.aborted

    async function runMember<T>(state: Ref<MemberState>, fetch: () => Promise<T>, apply: (result: T) => void) {
      if (state.value === 'loading' || state.value === 'done') return
      state.value = 'loading'
      const result = await fetch()
      if (!current()) return
      apply(result)
      state.value = 'done'
    }

    const tasks: Promise<void>[] = []
    if (hardcoverAllowed.value)
      tasks.push(
        runMember(
          hardcoverState,
          () => searchHardcoverUniversal(q, controller.signal),
          (result) => {
            unavailable.value = !result.available
            hardcoverBooks.value = result.books
            hardcoverAuthors.value = result.authors
          },
        ),
      )
    for (const [kind, member] of Object.entries(serialMembers) as Array<['manga' | 'novel', typeof serialMembers.manga]>) {
      const { allowed, state, items: entries } = member
      if (!allowed.value) continue
      tasks.push(
        runMember(
          state,
          () => discoverSerials(q, kind, controller.signal).catch(() => ({ results: [], fallback: null })),
          (result) => {
            entries.value = result.fallback ? [] : result.results
            if (!entries.value.length && kind === 'manga' && tab.value === 'manga') tab.value = 'all'
          },
        ),
      )
    }
    await Promise.all(tasks)
  }

  watch([isOpen, options.localReady, options.strongMatches, ...memberList.flatMap((member) => [member.allowed, member.state])], () => {
    if (!isOpen.value || !options.localReady.value || options.strongMatches.value >= STRONG_MATCH_TARGET) return
    const idle = memberList.filter((member) => member.allowed.value && member.state.value === 'idle')
    if (!idle.length) return
    for (const member of idle) member.state.value = 'waiting'
    clearTimeout(externalTimer)
    const generation = externalGeneration
    externalTimer = setTimeout(() => {
      if (generation === externalGeneration) void searchExternal()
    }, EXTERNAL_DELAY_MS)
  })
  watch(tab, (value) => {
    if (['hardcover', 'manga', 'lightNovels'].includes(value)) void searchExternal()
  })
  watch(query, resetExternal)
  watch(isOpen, (open) => {
    if (open) unavailable.value = false
    else resetExternal()
  })
  onScopeDispose(resetExternal)
  return { members, anyLoading, anyIdle, searchExternal }
}

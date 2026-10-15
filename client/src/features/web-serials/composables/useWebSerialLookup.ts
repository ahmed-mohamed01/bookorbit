import { computed, ref, watch, type Ref } from 'vue'
import type { WebSerialMetadataOverride, WebSerialSeriesDetail, WebSerialSeriesLookup, WebSerialSeriesMatch } from '@bookorbit/types'
import { i18n } from '@/i18n'
import { fetchSeriesLookup } from '../api/webSerials'
import { messageOf } from '../lib/messageOf'

export function splitSourceAuthors(author: string | null | undefined): string[] {
  return (author ?? '')
    .split(/[,;]/)
    .map((value) => value.trim())
    .filter(Boolean)
}

function cleaned(values: readonly string[]): string[] {
  return values.map((value) => value.trim()).filter(Boolean)
}

/**
 * `preset`: the series-database match already known (the sheet was opened from a search result). It is the match from the
 * start, and the server only has to supply the volume map for it.
 */
export function useWebSerialLookup(detail: Ref<WebSerialSeriesDetail | null>, preset?: Ref<WebSerialSeriesMatch | null>) {
  const lookup = ref<WebSerialSeriesLookup | null>(null)
  const loading = ref(false)
  const rejected = ref(false)
  const authors = ref<string[]>([])
  const artists = ref<string[]>([])
  // Once the user edits a credit, a late lookup result must not overwrite it.
  const authorsEdited = ref(false)
  const artistsEdited = ref(false)
  let token = 0
  let keepCreditsOnNextChange = false

  // The preset is only what the opening row knew; the server's match for the same id carries the full credits and publication.
  const match = computed<WebSerialSeriesMatch | null>(() => {
    if (rejected.value) return null
    const found = lookup.value?.state === 'matched' ? lookup.value.match : null
    if (preset?.value) return found?.id === preset.value.id ? found : preset.value
    return found
  })
  const state = computed(() => {
    if (rejected.value) return 'rejected'
    if (preset?.value) return 'matched'
    return loading.value ? 'loading' : (lookup.value?.state ?? 'idle')
  })
  const unavailableMessage = computed(() => lookup.value?.message?.trim() || i18n.global.t('webSerials.api.lookup'))
  const chapterVolumes = computed(() => lookup.value?.chapterVolumes ?? null)
  const canonicalTitle = computed(() => match.value?.title ?? detail.value?.title ?? '')
  const sourceTitleDiffers = computed(() => match.value !== null && detail.value !== null && match.value.title !== detail.value.title)
  const sourceAuthors = computed(() => splitSourceAuthors(detail.value?.author))
  const hasNoAuthor = computed(() => cleaned(authors.value).length === 0)

  function applyDefaults(): void {
    if (!authorsEdited.value) authors.value = match.value && match.value.authors.length > 0 ? [...match.value.authors] : [...sourceAuthors.value]
    if (!artistsEdited.value) artists.value = match.value ? [...match.value.artists] : []
  }

  async function load(): Promise<void> {
    const current = detail.value
    const mine = ++token
    if (!current) {
      lookup.value = null
      loading.value = false
      applyDefaults()
      return
    }
    loading.value = true
    try {
      const presetId = preset?.value?.id
      const result = await (presetId ? fetchSeriesLookup(current.seriesKey, presetId) : fetchSeriesLookup(current.seriesKey))
      if (mine !== token) return
      lookup.value = result
    } catch (cause) {
      if (mine !== token) return
      lookup.value = {
        state: 'unavailable',
        match: null,
        message: messageOf(cause, 'webSerials.api.lookup'),
        chapterVolumes: null,
      }
    }
    loading.value = false
    applyDefaults()
  }

  function reset(): void {
    lookup.value = null
    rejected.value = false
    if (keepCreditsOnNextChange) {
      keepCreditsOnNextChange = false
    } else {
      authorsEdited.value = false
      artistsEdited.value = false
      authors.value = [...sourceAuthors.value]
      artists.value = []
    }
    void load()
  }

  /** Switching the download source keeps the credits the user already settled on. */
  function keepCreditsForNextSeries(): void {
    keepCreditsOnNextChange = true
  }

  function rejectMatch(): void {
    rejected.value = true
    authorsEdited.value = false
    artistsEdited.value = false
    applyDefaults()
  }

  function restoreMatch(): void {
    rejected.value = false
    authorsEdited.value = false
    artistsEdited.value = false
    applyDefaults()
  }

  function setAuthors(values: string[]): void {
    authors.value = values
    authorsEdited.value = true
  }

  function setArtists(values: string[]): void {
    artists.value = values
    artistsEdited.value = true
  }

  function metadata(): WebSerialMetadataOverride {
    const result: WebSerialMetadataOverride = { matchId: match.value?.id ?? null }
    // The server rejects an empty list, so a credit nobody filled in is left out instead. The site's authors standing in
    // for a match that named none are left to the server, which reads the full match by id.
    const authorList = cleaned(authors.value)
    const siteFallback = !authorsEdited.value && match.value !== null && match.value.authors.length === 0
    if (authorList.length > 0 && !siteFallback) result.authors = authorList
    const artistList = cleaned(artists.value)
    if (detail.value?.kind === 'manga' && artistList.length > 0) result.artists = artistList
    return result
  }

  watch(() => detail.value?.seriesKey ?? null, reset, { immediate: true })
  if (preset) watch(() => preset.value?.id ?? null, reset)

  return {
    lookup,
    loading,
    state,
    match,
    chapterVolumes,
    rejected,
    authors,
    artists,
    unavailableMessage,
    canonicalTitle,
    sourceTitleDiffers,
    hasNoAuthor,
    load,
    keepCreditsForNextSeries,
    rejectMatch,
    restoreMatch,
    setAuthors,
    setArtists,
    metadata,
  }
}

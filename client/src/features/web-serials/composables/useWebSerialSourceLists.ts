import { ref, type Ref } from 'vue'
import type { WebSerialMangaSource, WebSerialNovelSource, WebSerialSettings } from '@bookorbit/types'
import { fetchMangaSources, fetchNovelSources } from '../api/webSerials'
import { messageOf } from '../lib/messageOf'
import type { WebSerialSettingsDraft } from '../lib/settingsDraft'

/** The sources each engine offers; both lists only load once that engine has a saved URL. */
export function useWebSerialSourceLists(settings: Ref<WebSerialSettings | null>, draft: WebSerialSettingsDraft) {
  const novelSources = ref<WebSerialNovelSource[]>([])
  const novelSourcesLoading = ref(false)
  const novelSourcesError = ref<string | null>(null)
  const mangaSources = ref<WebSerialMangaSource[]>([])
  const mangaSourcesLoading = ref(false)
  const mangaSourcesError = ref<string | null>(null)

  async function loadNovelSources(): Promise<void> {
    if (!settings.value?.novel.url) {
      novelSources.value = []
      novelSourcesError.value = null
      return
    }
    novelSourcesLoading.value = true
    novelSourcesError.value = null
    try {
      novelSources.value = await fetchNovelSources()
    } catch (cause) {
      novelSources.value = []
      novelSourcesError.value = messageOf(cause, 'webSerials.api.novelSources')
    } finally {
      novelSourcesLoading.value = false
    }
  }

  /** The server drops an uninstalled extension's sources from the saved selection, so the page does the same to avoid writing them back. */
  function pruneSelectedSources(): void {
    const present = new Set(mangaSources.value.map((source) => source.id))
    const current = settings.value
    if (current?.manga.sourceIds) current.manga.sourceIds = current.manga.sourceIds.filter((id) => present.has(id))
    if (draft.manga.sourceIds) draft.manga.sourceIds = draft.manga.sourceIds.filter((id) => present.has(id))
  }

  async function loadMangaSources(): Promise<void> {
    if (!settings.value?.manga.url) {
      mangaSources.value = []
      mangaSourcesError.value = null
      return
    }
    mangaSourcesLoading.value = true
    mangaSourcesError.value = null
    try {
      mangaSources.value = await fetchMangaSources()
    } catch (cause) {
      mangaSources.value = []
      mangaSourcesError.value = messageOf(cause, 'webSerials.api.mangaSources')
    } finally {
      mangaSourcesLoading.value = false
    }
  }

  return {
    novelSources,
    novelSourcesLoading,
    novelSourcesError,
    mangaSources,
    mangaSourcesLoading,
    mangaSourcesError,
    loadNovelSources,
    loadMangaSources,
    pruneSelectedSources,
  }
}

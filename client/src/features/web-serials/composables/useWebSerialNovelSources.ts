import { computed, reactive, ref } from 'vue'
import type { WebSerialNovelSourceEntry } from '@bookorbit/types'
import { fetchAvailableNovelSources, fetchInstalledNovelSources, runNovelSourceAction } from '../api/webSerials'
import { messageOf } from '../lib/messageOf'

export function useWebSerialNovelSources(onChanged: () => void | Promise<void>) {
  const sources = ref<WebSerialNovelSourceEntry[]>([])
  const installed = ref<WebSerialNovelSourceEntry[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  const query = ref('')
  const language = ref('English')
  const busy = reactive<Record<string, 'install' | 'update' | 'remove'>>({})

  const filtered = computed(() => {
    const text = query.value.trim().toLocaleLowerCase()
    return sources.value.filter((source) => !text || `${source.name} ${source.site}`.toLocaleLowerCase().includes(text))
  })

  let loadToken = 0

  async function load(): Promise<void> {
    const mine = ++loadToken
    const wanted = language.value
    loading.value = true
    error.value = null
    try {
      const [available, current] = await Promise.all([fetchAvailableNovelSources(wanted), fetchInstalledNovelSources()])
      // A newer load, for instance for another language, owns the list now.
      if (mine !== loadToken) return
      const installedById = new Map(current.map((source) => [source.id, source]))
      const availableIds = new Set(available.map((source) => source.id))
      sources.value = [
        ...available.map((source) => {
          const installedSource = installedById.get(source.id)
          return installedSource ? { ...source, ...installedSource, updateAvailable: source.updateAvailable } : source
        }),
        ...current.filter((source) => source.lang === wanted && !availableIds.has(source.id)),
      ]
      installed.value = current
    } catch (cause) {
      if (mine === loadToken) error.value = messageOf(cause, 'webSerials.api.novelSources')
    } finally {
      if (mine === loadToken) loading.value = false
    }
  }

  async function act(source: WebSerialNovelSourceEntry, action: 'install' | 'update' | 'remove'): Promise<boolean> {
    if (busy[source.id]) return false
    busy[source.id] = action
    error.value = null
    try {
      await runNovelSourceAction(source.id, action)
      await load()
      await onChanged()
      return true
    } catch (cause) {
      error.value = messageOf(cause, 'webSerials.api.novelSourceAction')
      return false
    } finally {
      delete busy[source.id]
    }
  }

  function setLanguage(value: string): void {
    language.value = value
    void load()
  }

  return { sources, installed, filtered, loading, error, query, language, busy, load, act, setLanguage }
}

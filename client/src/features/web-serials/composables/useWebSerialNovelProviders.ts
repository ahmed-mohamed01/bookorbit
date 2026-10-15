import { computed, ref } from 'vue'
import { toast } from 'vue-sonner'
import type { WebSerialNovelProviders } from '@bookorbit/types'
import { fetchNovelProviders, saveNovelProviders } from '../api/webSerials'
import { messageOf } from '../lib/messageOf'
import { clearStoredSearch } from './webSerialSearchStore'

export function useWebSerialNovelProviders() {
  const providers = ref<WebSerialNovelProviders | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const linkQuery = ref('')
  const linkOpen = ref(false)
  let saveToken = 0

  const search = computed(() => providers.value?.search ?? [])
  const unavailable = computed(() => providers.value?.unavailable ?? false)
  const linkSitesTotal = computed(() => providers.value?.linkSitesTotal ?? 0)
  const filteredLinkSites = computed(() => {
    const needle = linkQuery.value.trim().toLowerCase()
    const sites = providers.value?.linkSites ?? []
    if (!needle) return sites
    return sites.filter((site) => site.name.toLowerCase().includes(needle) || site.domain.toLowerCase().includes(needle))
  })

  async function load(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      providers.value = await fetchNovelProviders()
    } catch (cause) {
      error.value = messageOf(cause, 'webSerials.api.novelProviders')
    } finally {
      loading.value = false
    }
  }

  async function toggle(domain: string, enabled: boolean): Promise<void> {
    const current = providers.value
    const entry = current?.search.find((item) => item.domain === domain)
    if (!current || !entry || entry.enabled === enabled) return
    entry.enabled = enabled
    const token = ++saveToken
    try {
      const saved = await saveNovelProviders({ disabledDomains: current.search.filter((item) => !item.enabled).map((item) => item.domain) })
      // The kept answer was searched with the old set of sites, so coming back to the page searches again.
      clearStoredSearch()
      if (token === saveToken) providers.value = saved
    } catch (cause) {
      entry.enabled = !enabled
      toast.error(messageOf(cause, 'webSerials.api.saveNovelProviders'))
    }
  }

  function setLinkQuery(value: string): void {
    linkQuery.value = value
  }

  function toggleLinkOpen(): void {
    linkOpen.value = !linkOpen.value
  }

  return {
    providers,
    loading,
    error,
    search,
    unavailable,
    linkSitesTotal,
    linkQuery,
    linkOpen,
    filteredLinkSites,
    load,
    toggle,
    setLinkQuery,
    toggleLinkOpen,
  }
}

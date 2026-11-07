import { createCachedRequest } from '@/lib/cached-request'
import { ref } from 'vue'
import { api } from '@/lib/api'
import type { ProviderLinkSettings } from '@/features/book/lib/provider-links'

const DEFAULT_SETTINGS: ProviderLinkSettings = { amazonDomain: 'amazon.com' }
const settings = ref<ProviderLinkSettings>(DEFAULT_SETTINGS)
const pendingRequest = createCachedRequest(loadSettings)

export function invalidateProviderLinkSettings() {
  pendingRequest.invalidate()
}

async function loadSettings(): Promise<void> {
  try {
    const response = await api('/api/v1/metadata-preferences/provider-links')
    if (!response.ok) {
      pendingRequest.invalidate()
      return
    }
    const data: unknown = await response.json()
    if (typeof data === 'object' && data !== null && 'amazonDomain' in data && typeof data.amazonDomain === 'string' && data.amazonDomain.trim()) {
      settings.value = { amazonDomain: data.amazonDomain }
    }
  } catch {
    pendingRequest.invalidate()
  }
}

export function useProviderLinkSettings() {
  return { settings, loadSettings: () => pendingRequest.get() }
}

import { createCachedRequest } from '@/lib/cached-request'
import { ref } from 'vue'

import type { AppInfoResponse } from '@bookorbit/types'

import { api } from '@/lib/api'

const version = ref('')
const updateAvailable = ref<boolean | null>(null)
const latestVersion = ref<string | null>(null)
const maxUploadSizeMb = ref(500)
const isLoading = ref(false)
const error = ref<string | null>(null)

const appInfoRequest = createCachedRequest(fetchAppInfo)

async function fetchAppInfo() {
  isLoading.value = true
  error.value = null
  try {
    const res = await api('/api/v1/app-info')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data: AppInfoResponse = await res.json()
    if (data.updateAvailable === null) appInfoRequest.invalidate()
    version.value = data.version
    updateAvailable.value = data.updateAvailable
    latestVersion.value = data.latestVersion
    maxUploadSizeMb.value = data.maxUploadSizeMb ?? 500
  } catch (e) {
    appInfoRequest.invalidate()
    error.value = e instanceof Error ? e.message : 'Failed to load app info'
  } finally {
    isLoading.value = false
  }
}

export function useAppInfo() {
  const loadAppInfo = appInfoRequest.get
  return { version, updateAvailable, latestVersion, maxUploadSizeMb, isLoading, error, loadAppInfo }
}

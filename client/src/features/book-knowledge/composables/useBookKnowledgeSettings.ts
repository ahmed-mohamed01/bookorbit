import { onMounted, onScopeDispose, ref } from 'vue'
import type { BookKnowledgeSettings, UpdateBookKnowledgeSettings } from '@bookorbit/types'
import { api } from '@/lib/api'

export function useBookKnowledgeSettings(allowed: () => boolean) {
  const settings = ref<BookKnowledgeSettings | null>(null)
  const busy = ref(false)
  const failed = ref(false)
  const saved = ref(false)
  let controller: AbortController | undefined
  async function request(update?: UpdateBookKnowledgeSettings) {
    if (!allowed()) return
    controller?.abort()
    const current = new AbortController()
    controller = current
    busy.value = true
    failed.value = false
    saved.value = false
    try {
      const response = await api('/api/v1/book-knowledge/settings', {
        signal: current.signal,
        method: update ? 'PUT' : 'GET',
        ...(update ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(update) } : {}),
      })
      if (!response.ok) throw new Error('Settings request failed')
      const data = (await response.json()) as BookKnowledgeSettings
      if (!current.signal.aborted) {
        settings.value = data
        saved.value = !!update
      }
    } catch {
      if (!current.signal.aborted) failed.value = true
    } finally {
      if (controller === current) busy.value = false
    }
  }
  function load() {
    return request()
  }
  function save() {
    if (!settings.value) return
    return request({ enabled: settings.value.enabled })
  }
  onMounted(load)
  onScopeDispose(() => controller?.abort())
  return { settings, busy, failed, saved, load, save }
}

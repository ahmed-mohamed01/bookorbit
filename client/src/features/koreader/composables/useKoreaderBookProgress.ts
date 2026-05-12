import { ref } from 'vue'
import { api } from '@/lib/api'
import type { KoreaderBookSyncInfo } from '@bookorbit/types'

export function useKoreaderBookProgress() {
  const bookProgress = ref<KoreaderBookSyncInfo | null>(null)
  const loading = ref(false)

  async function fetchBookProgress(bookId: number): Promise<void> {
    loading.value = true
    try {
      const res = await api(`/api/v1/koreader/books/${bookId}/progress`)
      if (!res.ok) throw new Error('Failed to fetch book progress')
      bookProgress.value = await res.json()
    } catch {
      bookProgress.value = null
    } finally {
      loading.value = false
    }
  }

  return { bookProgress, loading, fetchBookProgress }
}

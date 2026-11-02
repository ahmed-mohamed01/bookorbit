import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import type { BookDetail, ReadAloudProgressSyncMode } from '@bookorbit/types'
import { api } from '@/lib/api'
import {
  editionSyncToggleKind,
  editionSyncToggleValue,
  planEditionSyncToggle,
  readAlongEditions,
  readAlongSyncCount,
  type EditionSyncToggleKind,
} from '../lib/toggle-plan'
import type { useEditionSyncBookState } from './useEditionSyncBookState'

interface Options {
  book: () => BookDetail
  editionSync: ReturnType<typeof useEditionSyncBookState>
  onSaved: (book: BookDetail) => void
}

export function useEditionSyncToggle({ book, editionSync, onSaved }: Options) {
  const { t } = useI18n()
  const savingReadAloud = ref(false)

  const readAlong = computed(() => readAlongEditions(book().files, book().formatPriority))
  const readAlongCount = computed(() => readAlongSyncCount(readAlong.value))
  // Upstream's read-aloud sync is per book and needs no edition sync permission or setting; only the timing index does.
  const kind = computed<EditionSyncToggleKind>(() => {
    if (readAlongCount.value !== null) return 'readAlong'
    if (!editionSync.visible.value) return 'none'
    return editionSyncToggleKind(editionSync.state.value) === 'index' ? 'index' : 'none'
  })
  const count = computed(() => {
    if (kind.value === 'readAlong') return readAlongCount.value
    return kind.value === 'index' ? editionSync.editionCount.value : null
  })
  const checked = computed(() => editionSyncToggleValue(kind.value, editionSync.state.value, book().readAloudSync.mode))
  const disabled = computed(() => savingReadAloud.value || (kind.value !== 'readAlong' && editionSync.busy.value))

  async function patchReadAloudMode(mode: ReadAloudProgressSyncMode): Promise<boolean> {
    savingReadAloud.value = true
    try {
      const res = await api(`/api/v1/books/${book().id}/read-aloud-sync`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      })
      if (!res.ok) throw new Error('Failed to update read-aloud sync')
      onSaved((await res.json()) as BookDetail)
      return true
    } catch {
      toast.error(t('book.detail.details.readAloudSync.saveFailed'))
      return false
    } finally {
      savingReadAloud.value = false
    }
  }

  async function toggle(value: boolean): Promise<void> {
    if (disabled.value) return
    const plan = planEditionSyncToggle(kind.value, value, book().readAloudSync.mode)
    if (plan.setIndexOverride && !(await editionSync.setSyncEnabled(value))) return
    if (plan.setReadAloudMode) await patchReadAloudMode(plan.setReadAloudMode)
  }

  return { kind, count, checked, disabled, toggle }
}

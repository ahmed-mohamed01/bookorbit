// Fork: Convert to M4B. The one gate for the book page's convert entry points: library managers,
// tool on, and a book with audio files.
import { computed, type MaybeRefOrGetter, toValue } from 'vue'
import { isAudioFormat, Permission, type BookDetail } from '@bookorbit/types'

import { usePermissions } from '@/features/auth/composables/usePermissions'
import { isAlreadyM4b } from '../lib/audio-convert'
import { useAudioConvertEnabled } from './useAudioConvertEnabled'

export function useAudioConvertVisible(book: MaybeRefOrGetter<BookDetail>) {
  const { hasPermission } = usePermissions()
  const canManage = computed(() => hasPermission(Permission.ManageLibraries))
  const { enabled } = useAudioConvertEnabled({ autoload: canManage.value })

  /** The Files tab button, which also explains why a book cannot convert. */
  const visible = computed(
    () => canManage.value && enabled.value === true && toValue(book).files.some((file) => file.format !== null && isAudioFormat(file.format)),
  )
  /** The ⋮ menu entries, which only appear when there is something to convert. */
  const offered = computed(() => visible.value && !isAlreadyM4b(toValue(book).files))

  return { visible, offered }
}

import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatDate } from '@/i18n/formatters'
import type { AlignmentBuildBlockReason, AlignmentStatus } from '@/features/book/composables/useReadingAlignment'
import { isTerminalBlock } from '@/features/book/lib/position-sync'

export interface PositionSyncStatusSource {
  status: AlignmentStatus
  builtAt: string | null
  buildBlocked: AlignmentBuildBlockReason | null
  canBuild: boolean
}

export function usePositionSyncStatus(source: () => PositionSyncStatusSource) {
  const { t } = useI18n()

  const running = computed(() => {
    const { status } = source()
    return status === 'pending' || status === 'building'
  })

  const tag = computed(() => {
    if (running.value) return { key: 'book.detail.readingAlignment.tag.building', class: 'bg-info/15 text-info' }
    switch (source().status) {
      case 'ready':
        return { key: 'book.detail.readingAlignment.tag.ready', class: 'bg-success/15 text-success' }
      case 'failed':
        return { key: 'book.detail.readingAlignment.tag.failed', class: 'bg-destructive/15 text-destructive' }
      case 'unalignable':
        return { key: 'book.detail.readingAlignment.tag.unalignable', class: 'bg-muted text-muted-foreground' }
      default:
        return { key: 'book.detail.readingAlignment.tag.none', class: 'bg-muted text-muted-foreground' }
    }
  })

  const showBuildButton = computed(() => source().canBuild && !running.value && !isTerminalBlock(source().buildBlocked))
  const isRebuild = computed(() => source().status !== 'none')

  const builtAtLabel = computed(() => {
    const builtAt = source().builtAt
    if (!builtAt) return null
    const parsed = new Date(builtAt)
    if (Number.isNaN(parsed.getTime())) return null
    return t('book.detail.readingAlignment.builtAt', { date: formatDate(parsed, { year: 'numeric', month: 'short', day: 'numeric' }) })
  })

  const blockMessage = computed(() => {
    switch (source().buildBlocked) {
      case 'disabled':
        return t('book.detail.readingAlignment.buildBlocked.disabled')
      case 'unavailable':
        return t('book.detail.readingAlignment.buildBlocked.unavailable')
      case 'busy':
        return t('book.detail.readingAlignment.buildBlocked.busy')
      default:
        return null
    }
  })

  return { running, tag, showBuildButton, isRebuild, builtAtLabel, blockMessage }
}

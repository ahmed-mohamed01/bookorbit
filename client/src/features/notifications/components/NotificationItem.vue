<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { X, FolderSync, PackageOpen, Mail, ArrowRightLeft, FileDown, TriangleAlert, BookOpenCheck } from '@lucide/vue'
import { NOTIFICATION_TYPE_META, NotificationSeverity, type NotificationItem, type NotificationTypeMeta } from '@bookorbit/types'
import { cancelReadAlongBuild } from '@/features/book/lib/read-along-cancel'
import { isLockedNotification, useNotifications } from '../composables/useNotifications'
import { NOTIFICATION_CATEGORY_ICONS } from '../lib/notification-category-groups'
import { Button } from '@/components/ui/button'

const props = defineProps<{ notification: NotificationItem }>()
const emit = defineEmits<{ read: [id: number]; dismiss: [id: number] }>()

const router = useRouter()
const { t } = useI18n()
const { formatRelativeTime } = useNotifications()

// Only types whose icon should differ from their category's. Everything else falls back to the
// category icon, so a new type can never render as the wrong thing by being forgotten here.
const TYPE_ICON_OVERRIDES: Partial<Record<NotificationItem['type'], typeof FolderSync>> = {
  scan_completed: FolderSync,
  scan_failed: FolderSync,
  books_unavailable: TriangleAlert,
  books_restored: BookOpenCheck,
  book_dock_finalized: PackageOpen,
  book_dock_finalized_with_errors: PackageOpen,
  email_sent: Mail,
  email_failed: Mail,
  migration_completed: ArrowRightLeft,
  migration_failed: ArrowRightLeft,
  file_write_back_completed: FileDown,
  file_write_back_failed: FileDown,
  file_rename_completed: FileDown,
  file_rename_failed: FileDown,
}

const meta = computed(() => (NOTIFICATION_TYPE_META as Partial<Record<string, NotificationTypeMeta>>)[props.notification.type])
const icon = computed(
  () => TYPE_ICON_OVERRIDES[props.notification.type] ?? (meta.value ? NOTIFICATION_CATEGORY_ICONS[meta.value.category] : FolderSync),
)
const isFailed = computed(() => meta.value?.severity === NotificationSeverity.Error)
const isWarning = computed(() => meta.value?.severity === NotificationSeverity.Warning)
const relativeTime = computed(() => formatRelativeTime(props.notification.updatedAt))
const occurrences = computed(() => props.notification.count)
// A notification that tracks a long operation carries its progress (0..1) until it is done.
const progressPercent = computed(() => {
  const progress = props.notification.meta?.progress
  if (typeof progress !== 'number' || Number.isNaN(progress) || props.notification.meta?.done === true) return null
  return Math.round(Math.min(Math.max(progress, 0), 1) * 100)
})

const locked = computed(() => isLockedNotification(props.notification))
const cancelTarget = computed(() => {
  const meta = props.notification.meta
  const bookId = meta?.bookId
  const buildId = meta?.buildId
  return meta?.cancellable === true && typeof bookId === 'number' && typeof buildId === 'number' ? { bookId, buildId } : null
})
const cancelling = ref(false)

// The server's cancel rewrites this notification over the socket, so success needs nothing here.
async function handleCancelBuild(e: Event) {
  e.stopPropagation()
  const target = cancelTarget.value
  if (target === null || cancelling.value) return
  cancelling.value = true
  try {
    const outcome = await cancelReadAlongBuild(target.bookId, target.buildId)
    if (outcome === 'too_late') toast.error(t('book.detail.editionLink.readAlong.cancelTooLate'))
    else if (outcome === 'failed') toast.error(t('book.detail.editionLink.readAlong.cancelUnavailable'))
  } finally {
    cancelling.value = false
  }
}

function handleClick() {
  if (!props.notification.read) {
    emit('read', props.notification.id)
  }
  const actionUrl = props.notification.actionUrl
  if (actionUrl) {
    if (actionUrl.startsWith('/')) {
      router.push(actionUrl)
    } else {
      window.open(actionUrl, '_blank')
    }
  }
}

function handleDismiss(e: Event) {
  e.stopPropagation()
  emit('dismiss', props.notification.id)
}
</script>

<template>
  <div class="group relative">
    <button
      type="button"
      class="flex w-full cursor-pointer items-start gap-3 rounded-lg border px-3 py-3 pr-10 text-left transition-all hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      :class="[
        notification.read
          ? 'border-border/30 bg-muted/20 hover:border-border/50 hover:bg-muted/40'
          : 'border-border/60 bg-card shadow-sm hover:bg-muted/30',
        cancelTarget !== null ? 'pb-10' : '',
      ]"
      @click="handleClick"
    >
      <div class="relative mt-0.5 shrink-0">
        <div
          class="flex items-center justify-center rounded-lg p-1.5"
          :class="isFailed ? 'bg-destructive/10' : isWarning ? 'bg-warning/10' : 'bg-success/10'"
        >
          <component :is="icon" :size="15" :class="isFailed ? 'text-destructive' : isWarning ? 'text-warning' : 'text-success'" />
        </div>
        <span v-if="!notification.read" class="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-primary ring-2 ring-background" />
      </div>

      <div class="min-w-0 flex-1">
        <div class="flex items-start justify-between gap-2">
          <p class="truncate text-sm leading-tight" :class="notification.read ? 'text-foreground' : 'font-semibold text-foreground'">
            {{ notification.title }}
          </p>
          <div class="flex shrink-0 items-center gap-1.5">
            <span
              v-if="occurrences > 1"
              class="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-muted-foreground"
              :aria-label="$t('notifications.occurrences', { count: occurrences })"
            >
              {{ $t('notifications.occurrencesShort', { count: occurrences }) }}
            </span>
            <span class="text-[11px] text-muted-foreground">{{ relativeTime }}</span>
          </div>
        </div>
        <p v-if="notification.message" class="mt-1 truncate text-xs text-muted-foreground">
          {{ notification.message }}
        </p>
        <!-- Inside a button, where a progressbar role is ignored; the message carries the percentage. -->
        <div
          v-if="progressPercent !== null"
          class="mt-1.5 h-1 overflow-hidden rounded-full bg-muted"
          aria-hidden="true"
          data-testid="notification-progress"
        >
          <div class="h-full rounded-full bg-info" :style="{ width: `${progressPercent}%` }" />
        </div>
      </div>
    </button>

    <Button
      v-if="cancelTarget !== null"
      variant="ghost"
      size="sm"
      class="absolute bottom-2 right-2 h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
      :disabled="cancelling"
      :aria-label="t('notifications.cancelBuildLabel')"
      data-testid="notification-cancel-build"
      @click="handleCancelBuild"
    >
      <X :size="13" aria-hidden="true" />
      {{ t('notifications.cancelBuild') }}
    </Button>

    <button
      v-if="!locked"
      type="button"
      :aria-label="$t('notifications.dismiss')"
      class="absolute right-2 top-2 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
      @click="handleDismiss"
    >
      <X :size="14" aria-hidden="true" />
    </button>
  </div>
</template>

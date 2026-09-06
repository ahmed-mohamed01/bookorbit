<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertTriangle, AudioLines, Ban, CheckCircle2, Loader2, RefreshCw } from '@lucide/vue'
import { toast } from 'vue-sonner'
import { Permission, type BookDetail } from '@bookorbit/types'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { formatDate } from '@/i18n/formatters'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import { getBookLinkModality, useEditionLink } from '@/features/book/composables/useEditionLink'
import { useReadingAlignment } from '@/features/book/composables/useReadingAlignment'

const props = defineProps<{ book: BookDetail }>()

const { t } = useI18n()

const modality = computed(() => getBookLinkModality(props.book.files))
const needsLink = computed(() => modality.value === 'text' || modality.value === 'audio')

const editionLink = useEditionLink(props.book.id)
const alignment = useReadingAlignment()

const { hasPermission } = usePermissions()
const canEditMetadata = computed(() => hasPermission(Permission.LibraryEditMetadata))

const checked = ref(false)
const open = ref(false)

const pairExists = computed(() => {
  if (modality.value === 'both') return true
  if (needsLink.value) return editionLink.link.value !== null
  return false
})

const displayMode = computed<'hidden' | 'control'>(() => {
  if (modality.value === 'none') return 'hidden'
  // A book that still needs a counterpart linked shows nothing here: the adjacent "Link book"
  // control owns that action and explains the alignment benefit in its own hover tooltip. We only
  // surface the alignment status once a pair actually exists (linked, or one record with both formats).
  if (!pairExists.value) return 'hidden'
  return 'control'
})

const statusLabel = computed(() => t(`book.detail.readingAlignment.status.${alignment.status.value}`))

const statusIcon = computed(() => {
  switch (alignment.status.value) {
    case 'ready':
      return CheckCircle2
    case 'building':
      return Loader2
    case 'failed':
      return AlertTriangle
    case 'unalignable':
      return Ban
    default:
      return AudioLines
  }
})

const statusIconClass = computed(() => {
  switch (alignment.status.value) {
    case 'ready':
      return 'text-primary'
    case 'building':
      return 'text-foreground animate-spin'
    case 'failed':
      return 'text-destructive'
    case 'unalignable':
      return 'text-muted-foreground'
    default:
      return 'text-muted-foreground'
  }
})

const anchorLabel = computed(() => {
  const count = alignment.anchorCount.value ?? 0
  const key = count === 1 ? 'book.detail.readingAlignment.anchorFound' : 'book.detail.readingAlignment.anchorsFound'
  return t(key, { count })
})

const builtAtLabel = computed(() => {
  if (!alignment.builtAt.value) return null
  const parsed = new Date(alignment.builtAt.value)
  if (Number.isNaN(parsed.getTime())) return null
  return t('book.detail.readingAlignment.builtAt', { date: formatDate(parsed, { year: 'numeric', month: 'short', day: 'numeric' }) })
})

const showInSyncHint = computed(() => alignment.status.value === 'ready' && needsLink.value && editionLink.linkedCounterpart.value?.title)

const buildBlockedMessage = computed(() => {
  switch (alignment.buildBlocked.value) {
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

// 'busy' is a transient block (server at capacity right now): the build button stays available so the
// user can retry. 'disabled' and 'unavailable' only change with a server config update, so they stay
// terminal until then.
const isTerminalBuildBlock = computed(() => alignment.buildBlocked.value === 'disabled' || alignment.buildBlocked.value === 'unavailable')

// 'unalignable' stays rebuildable: it can be a retryable cause (a since-fixed missing duration or a bad
// model), so the user needs a retry path. A genuinely unalignable pair simply returns unalignable again.
const showBuildButton = computed(() => canEditMetadata.value && alignment.status.value !== 'building' && !isTerminalBuildBlock.value)

const isRebuild = computed(
  () => alignment.status.value === 'ready' || alignment.status.value === 'unalignable' || alignment.status.value === 'failed',
)

// Force is only needed to rebuild a 'ready' alignment (an unforced build of unchanged content is skipped
// as up-to-date). For a 'failed' row we must NOT force, so the build service can RESUME an interrupted
// build from where it left off; 'unalignable'/'none' build fresh either way.
const forceRebuild = computed(() => alignment.status.value === 'ready')

async function loadInitialState() {
  if (modality.value === 'none') {
    checked.value = true
    return
  }
  const loads: Promise<unknown>[] = [alignment.fetchStatus(props.book.id)]
  if (needsLink.value) loads.push(editionLink.loadForBook())
  await Promise.all(loads)
  checked.value = true
}

onMounted(loadInitialState)

async function handleBuildClick() {
  await alignment.build(props.book.id, forceRebuild.value)
  if (alignment.error.value) toast.error(t('book.detail.readingAlignment.buildFailed'))
}

function handleOpenChange(next: boolean) {
  open.value = next
}
</script>

<template>
  <Popover v-if="checked && displayMode === 'control'" :open="open" @update:open="handleOpenChange">
    <PopoverTrigger as-child>
      <button
        type="button"
        class="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        data-testid="alignment-trigger"
      >
        <component :is="statusIcon" class="size-3.5" :class="statusIconClass" />
        {{ statusLabel }}
      </button>
    </PopoverTrigger>
    <PopoverContent align="end" class="w-72 p-3">
      <p class="text-sm font-semibold text-foreground">{{ t('book.detail.readingAlignment.title') }}</p>

      <div class="mt-3 rounded-lg border border-border bg-background p-2.5">
        <div class="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <component :is="statusIcon" class="size-3.5 shrink-0" :class="statusIconClass" />
          {{ statusLabel }}
        </div>

        <div v-if="alignment.status.value === 'building'" class="mt-1.5 space-y-0.5" data-testid="alignment-building">
          <p class="text-xs text-muted-foreground">
            {{ t('book.detail.readingAlignment.progress', { done: alignment.samplesDone.value ?? 0, total: alignment.samplesTotal.value ?? '?' }) }}
          </p>
          <p class="text-xs text-muted-foreground">{{ anchorLabel }}</p>
        </div>

        <div v-else-if="alignment.status.value === 'ready'" class="mt-1.5 space-y-0.5" data-testid="alignment-ready">
          <p v-if="builtAtLabel" class="text-xs text-muted-foreground">{{ builtAtLabel }}</p>
          <p class="text-xs text-muted-foreground">{{ anchorLabel }}</p>
          <p v-if="showInSyncHint" class="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
            <RefreshCw class="size-3 shrink-0" />
            {{ t('book.detail.readingAlignment.inSyncWith', { title: editionLink.linkedCounterpart.value?.title }) }}
          </p>
        </div>

        <p v-if="alignment.status.value === 'unalignable'" class="mt-1.5 text-xs text-muted-foreground" data-testid="alignment-unalignable">
          {{ t('book.detail.readingAlignment.unalignableHint') }}
        </p>

        <p v-if="buildBlockedMessage" class="mt-1.5 text-xs text-muted-foreground" data-testid="alignment-build-blocked">
          {{ buildBlockedMessage }}
        </p>

        <button
          v-if="showBuildButton"
          type="button"
          class="mt-2 inline-flex h-7 items-center gap-1.5 rounded-md bg-primary px-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="alignment.mutating.value"
          data-testid="alignment-build-button"
          @click="handleBuildClick"
        >
          <Loader2 v-if="alignment.mutating.value" class="size-3.5 animate-spin" />
          <RefreshCw v-else-if="isRebuild" class="size-3.5" />
          <AudioLines v-else class="size-3.5" />
          {{ isRebuild ? t('book.detail.readingAlignment.rebuildButton') : t('book.detail.readingAlignment.buildButton') }}
        </button>
      </div>
    </PopoverContent>
  </Popover>
</template>

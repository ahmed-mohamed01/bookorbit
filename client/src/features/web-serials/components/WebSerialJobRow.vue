<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { ArrowRightLeft, ArrowUpToLine, ChevronDown, Clock, EllipsisVertical, FolderOpen, Pause, Play, RefreshCw, Trash2, X } from '@lucide/vue'
import type { WebSerialJob, WebSerialJobItem } from '@bookorbit/types'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatNumber, formatPercent } from '@/i18n/formatters'
import type { SerialJobDetailState } from '../composables/useWebSerialQueue'
import { INLINE_JOB_ACTIONS, isActiveJob, jobActions, jobProgressPercent } from '../lib/serialJobStatus'
import type { SerialJobAction } from '../lib/serialJobStatus'
import WebSerialCover from './WebSerialCover.vue'
import WebSerialIconButton from './WebSerialIconButton.vue'
import WebSerialJobItems from './WebSerialJobItems.vue'
import WebSerialStatusBadge from './WebSerialStatusBadge.vue'

const props = defineProps<{ job: WebSerialJob; busy: boolean; expanded?: boolean; detail?: SerialJobDetailState }>()
const emit = defineEmits<{
  action: [type: SerialJobAction, job: WebSerialJob]
  toggle: [job: WebSerialJob]
  retryItem: [job: WebSerialJob, item: WebSerialJobItem]
}>()

const ICONS = { pause: Pause, resume: Play, retry: RefreshCw, cancel: X } as const

const { t } = useI18n()
const active = computed(() => isActiveJob(props.job))
const paused = computed(() => props.job.status === 'paused')
const actions = computed(() => jobActions(props.job))
const inlineActions = computed(() => INLINE_JOB_ACTIONS.filter((action) => actions.value.includes(action) && action !== 'open'))
const menuActions = computed(() => actions.value.filter((action) => !INLINE_JOB_ACTIONS.includes(action)))
const percent = computed(() => jobProgressPercent(props.job))
const finishedUnits = computed(() => props.job.unitsDone + props.job.unitsSkipped)
const showBar = computed(() => (active.value || paused.value) && props.job.unitsTotal > 0)
const singleBook = computed(() => props.job.unitsTotal === 1)
const booksLine = computed(() => {
  if (props.job.unitsTotal <= 0) return t('webSerials.queue.preparing')
  return t(`webSerials.queue.progress.${props.job.packaging}`, {
    done: formatNumber(finishedUnits.value),
    total: formatNumber(props.job.unitsTotal),
  })
})
// While a failed chapter waits to be retried the job still carries its last step, which is no longer happening.
const waitNotice = computed(() => (active.value ? props.job.message : null))
const currentText = computed(() => {
  const current = props.job.current
  if (!current || waitNotice.value) return null
  if (current.stage === 'building') return t('webSerials.queue.current.building')
  if (current.stage === 'importing') return t('webSerials.queue.current.importing')
  if (current.chaptersDone !== null && current.chaptersTotal !== null && current.chaptersTotal > 0) {
    return t('webSerials.queue.current.chapters', { done: formatNumber(current.chaptersDone), total: formatNumber(current.chaptersTotal) })
  }
  return t(props.job.packaging === 'chapter' ? 'webSerials.queue.current.downloading' : 'webSerials.queue.current.fetching')
})
// One book: the chapter progress is the whole story. Several books: count books, and say what the current one is doing.
const progressLine = computed(() => (singleBook.value && currentText.value ? currentText.value : booksLine.value))
const detailLine = computed(() => {
  if (singleBook.value || !currentText.value || !props.job.current) return null
  return t('webSerials.queue.current.now', { label: props.job.current.label, detail: currentText.value })
})
const metaLine = computed(() => {
  const parts = [props.job.sourceName, t(`webSerials.packaging.${props.job.packaging}`)]
  if (props.job.libraryName) parts.push(props.job.libraryName)
  if (props.job.owner) parts.push(props.job.owner.name)
  return parts.join(' · ')
})
const failedLine = computed(() => (props.job.unitsFailed > 0 ? t('webSerials.queue.failedUnits', { count: props.job.unitsFailed }) : null))
const problemMessage = computed(() => {
  if (!leftoverFailures.value) return props.job.message || failedLine.value || t('webSerials.queue.problemFallback')
  return [props.job.status === 'cancelled' ? props.job.message : null, failedLine.value].filter(Boolean).join(' ')
})
const leftoverFailures = computed(() => (props.job.status === 'completed' || props.job.status === 'cancelled') && props.job.unitsFailed > 0)
const showProblem = computed(() => props.job.status === 'failed' || props.job.status === 'completed_with_gaps' || leftoverFailures.value)
const openLibrary = computed(() => actions.value.includes('open') && props.job.libraryId > 0)
const queueLine = computed(() => (props.job.queuePosition ? t('webSerials.queue.inLine', { position: formatNumber(props.job.queuePosition) }) : null))

function actionLabel(action: SerialJobAction): string {
  return t(`webSerials.queue.actions.${action}Label`, { title: props.job.title })
}

function actionTooltip(action: SerialJobAction): string {
  return t(`webSerials.queue.actions.${action}`)
}

function iconFor(action: SerialJobAction) {
  return ICONS[action as keyof typeof ICONS]
}

function handleAction(action: SerialJobAction) {
  emit('action', action, props.job)
}

function handleMoveToTop() {
  handleAction('moveToTop')
}

function handleMove() {
  handleAction('move')
}

function handleRemove() {
  handleAction('remove')
}

function handleToggle() {
  emit('toggle', props.job)
}

function handleRetryItem(item: WebSerialJobItem) {
  emit('retryItem', props.job, item)
}
</script>

<template>
  <li class="rounded-lg border border-border bg-card p-3 shadow-xs">
    <div class="flex items-start gap-3">
      <WebSerialCover :src="job.coverUrl" :title="job.title" class="h-[74px] w-[50px]" />
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
          <div class="min-w-0 flex-1 basis-40">
            <div class="flex min-w-0 items-center gap-2">
              <p class="truncate text-[15px] font-semibold text-foreground">{{ job.title }}</p>
              <span class="shrink-0 rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-foreground">
                {{ t(`webSerials.kind.${job.kind}`) }}
              </span>
            </div>
            <p v-if="job.author" class="truncate text-xs text-muted-foreground">{{ job.author }}</p>
          </div>
          <div class="flex flex-wrap items-center justify-end gap-1.5">
            <span v-if="queueLine" class="text-xs font-medium text-muted-foreground tabular-nums">{{ queueLine }}</span>
            <WebSerialStatusBadge :status="job.status" />
            <WebSerialIconButton
              v-for="action in inlineActions"
              :key="action"
              :icon="iconFor(action)"
              :label="actionLabel(action)"
              :tooltip="actionTooltip(action)"
              :busy="busy"
              :variant="action === 'cancel' ? 'destructive-outline' : 'outline'"
              @click="handleAction(action)"
            />
            <Tooltip v-if="openLibrary">
              <TooltipTrigger as-child>
                <RouterLink
                  :to="{ name: 'library', params: { id: job.libraryId } }"
                  :aria-label="t('webSerials.queue.actions.openLabel', { title: job.title })"
                  class="inline-flex size-8 items-center justify-center rounded-md border border-border bg-background text-foreground shadow-xs transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <FolderOpen :size="14" aria-hidden="true" />
                </RouterLink>
              </TooltipTrigger>
              <TooltipContent>{{ t('webSerials.queue.open') }}</TooltipContent>
            </Tooltip>
            <DropdownMenu v-if="menuActions.length > 0">
              <DropdownMenuTrigger as-child>
                <Button variant="outline" size="icon-sm" :disabled="busy" :aria-label="t('webSerials.queue.actions.more', { title: job.title })">
                  <EllipsisVertical :size="14" aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem v-if="menuActions.includes('moveToTop')" @select="handleMoveToTop">
                  <ArrowUpToLine :size="14" aria-hidden="true" />
                  {{ t('webSerials.queue.actions.moveToTop') }}
                </DropdownMenuItem>
                <DropdownMenuItem v-if="menuActions.includes('move')" @select="handleMove">
                  <ArrowRightLeft :size="14" aria-hidden="true" />
                  {{ t('webSerials.queue.actions.move') }}
                </DropdownMenuItem>
                <DropdownMenuItem v-if="menuActions.includes('remove')" @select="handleRemove">
                  <Trash2 :size="14" aria-hidden="true" />
                  {{ t('webSerials.queue.actions.remove') }}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <p class="mt-1 truncate text-xs text-muted-foreground">{{ metaLine }}</p>

        <div v-if="active || paused" class="mt-2.5 rounded-md border border-border bg-muted/40 p-2">
          <div class="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span class="font-medium text-foreground">{{ progressLine }}</span>
            <span v-if="showBar" class="text-muted-foreground tabular-nums">{{ formatPercent(percent / 100) }}</span>
          </div>
          <div
            v-if="showBar"
            class="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-border"
            role="progressbar"
            :aria-valuenow="percent"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-label="t('webSerials.queue.progressLabel', { title: job.title })"
          >
            <div
              class="h-full rounded-full bg-primary transition-[width] duration-500 motion-reduce:transition-none"
              :style="{ width: `${percent}%` }"
            />
          </div>
          <p v-if="detailLine" class="mt-1.5 truncate text-xs text-muted-foreground">{{ detailLine }}</p>
          <p v-if="paused" class="mt-1.5 flex items-start gap-1.5 text-xs text-muted-foreground">
            <Pause :size="12" class="mt-0.5 shrink-0" aria-hidden="true" />
            <span>{{ t('webSerials.queue.pausedNotice') }}</span>
          </p>
          <p v-if="waitNotice" class="mt-1.5 flex items-start gap-1.5 text-xs text-muted-foreground">
            <Clock :size="12" class="mt-0.5 shrink-0" aria-hidden="true" />
            <span>{{ waitNotice }}</span>
          </p>
        </div>

        <p
          v-if="showProblem"
          class="mt-2.5 rounded-lg border p-3 text-sm"
          :class="job.status === 'failed' ? 'border-destructive/30 bg-destructive/5 text-destructive' : 'border-warning/30 bg-warning/5 text-warning'"
        >
          {{ problemMessage }}
        </p>

        <Button
          variant="ghost"
          size="sm"
          class="-ms-2 mt-2 h-7 gap-1 px-2 text-xs text-muted-foreground"
          :aria-expanded="expanded === true"
          :aria-controls="`web-serial-job-${job.id}-items`"
          @click="handleToggle"
        >
          <ChevronDown :size="14" class="transition-transform motion-reduce:transition-none" :class="{ 'rotate-180': expanded }" aria-hidden="true" />
          {{ t(expanded ? 'webSerials.queue.details.hide' : 'webSerials.queue.details.show') }}
        </Button>
      </div>
    </div>
    <WebSerialJobItems v-if="expanded" :state="detail" :job-id="job.id" :can-retry="job.status !== 'cancelled'" @retry="handleRetryItem" />
  </li>
</template>

<script setup lang="ts">
// Fork: Convert to M4B. Detail pane for the open book: what the conversion would do, or why it can't.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertTriangle, Check, ChevronLeft, ChevronRight, ExternalLink, EyeOff, Loader2, Play, SkipForward, Undo2, Zap } from '@lucide/vue'
import type { AudioConvertJob, AudioConvertPlan, AudioConvertPlanFile, AudioConvertPreviewItem } from '@bookorbit/types'

import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { formatBytes } from '@/lib/formatting'
import { formatRelativeTimeFromNow } from '@/i18n/formatters'
import { errorKey, formatClock, pipelineIndex, stageKey } from '../lib/audio-convert'

const props = defineProps<{
  item: AudioConvertPreviewItem | null
  plan: AudioConvertPlan | null
  planLoading: boolean
  planFailed: boolean
  index: number
  total: number
  selected: boolean
  selectedCount: number
  /** Saved backup window, or `null` when the viewer cannot read settings. */
  backupDays: number | null
  /** A Skip / Convert now request is in flight for this job id. */
  actingJobId: string | null
}>()

const emit = defineEmits<{
  step: [delta: number]
  'toggle-selected': []
  convert: []
  skip: [job: AudioConvertJob]
  'convert-now': [job: AudioConvertJob]
  'retry-plan': []
  back: []
}>()

const { t } = useI18n()

const FILE_LIMIT = 6

const files = computed<AudioConvertPlanFile[]>(() => props.plan?.files ?? [])
const shownFiles = computed(() => files.value.slice(0, FILE_LIMIT))
const hiddenFiles = computed(() => Math.max(0, files.value.length - FILE_LIMIT))
const merging = computed(() => files.value.length > 1)
const job = computed<AudioConvertJob | null>(() => props.item?.job ?? props.plan?.latestJob ?? null)
const authors = computed(() => props.item?.authors.join(', ') ?? '')

function fileDetail(file: AudioConvertPlanFile): string {
  const parts = [formatBytes(file.sizeBytes)]
  const codec = [file.codec?.toUpperCase(), file.bitrateKbps ? t('audioConvert.detail.kbps', { value: file.bitrateKbps }) : null]
    .filter(Boolean)
    .join(' ')
  if (codec) parts.push(codec)
  if (file.sampleRate) parts.push(t('audioConvert.detail.khz', { value: Math.round(file.sampleRate / 100) / 10 }))
  return parts.join(' · ')
}

const audioRow = computed(() => {
  const plan = props.plan
  if (!plan?.autoCodec) return { value: '-', note: '' }
  const value = plan.autoCodec === 'copy' ? t('audioConvert.codec.copy') : t('audioConvert.codec.aac')
  const note = plan.autoCodecReason ? t(`audioConvert.codecReason.${plan.autoCodecReason}`) : ''
  return { value, note }
})

const lengthRow = computed(() => {
  const plan = props.plan
  if (!plan) return ''
  const clock = formatClock(plan.totalDurationMs)
  return plan.autoCodec === 'copy' ? t('audioConvert.detail.lengthUnchanged', { length: clock }) : clock
})

const chaptersRow = computed(() => {
  const plan = props.plan
  if (!plan || plan.chapterSource === 'none' || plan.chapterCount === 0) return t('audioConvert.detail.chapters.none')
  return t(`audioConvert.detail.chapters.${plan.chapterSource}`, { count: plan.chapterCount })
})

const metadataRow = computed(() => (props.plan?.hasCover ? t('audioConvert.detail.metadataWithCover') : t('audioConvert.detail.metadata')))

const positionsRow = computed(() => {
  const plan = props.plan
  if (!plan) return ''
  const listeners = plan.listenersWithProgress
  let text =
    listeners === 0
      ? t('audioConvert.detail.positions.none')
      : merging.value
        ? t('audioConvert.detail.positions.moved', { count: listeners })
        : t('audioConvert.detail.positions.kept', { count: listeners })
  if (plan.bookmarkCount > 0) text += ` · ${t('audioConvert.detail.positions.bookmarks', { count: plan.bookmarkCount })}`
  return text
})

const readAlongRow = computed(() => {
  if (!props.plan?.hasReadAlong) return t('audioConvert.detail.readAlong.none')
  return merging.value ? t('audioConvert.detail.readAlong.rebuilt') : t('audioConvert.detail.readAlong.kept')
})

const originalRow = computed(() => {
  if (props.backupDays === null) return t('audioConvert.detail.original.unknown')
  if (props.backupDays === 0) return t('audioConvert.detail.original.deleted')
  return t('audioConvert.detail.original.kept', { days: props.backupDays })
})

const outputSize = computed(() =>
  props.plan?.autoCodec === 'copy' ? t('audioConvert.detail.about', { size: formatBytes(props.plan.totalBytes) }) : '',
)

const reasonText = computed(() => {
  const item = props.item
  if (!item) return ''
  if (item.status === 'cannot') return item.reason ? t(`audioConvert.reason.${item.reason}`) : t('audioConvert.reason.unknown')
  if (item.status === 'converted') {
    const finished = job.value?.status === 'success' ? job.value.finishedAt : null
    return finished
      ? t('audioConvert.detail.convertedAt', { when: formatRelativeTimeFromNow(finished, { smallestUnit: 'minute' }) })
      : t('audioConvert.detail.alreadyM4b')
  }
  return ''
})

const PIPELINE = ['audioConvert.pipeline.metadata', 'audioConvert.pipeline.chapters', 'audioConvert.pipeline.convert'] as const
const pipelineAt = computed(() => pipelineIndex(job.value?.stage ?? null))
const nextStep = computed(() => {
  const at = job.value?.nextStepAt
  return at ? t('audioConvert.pipeline.next', { when: formatRelativeTimeFromNow(at, { smallestUnit: 'minute' }) }) : ''
})

const failedJob = computed(() => (job.value?.status === 'failed' && props.item?.status === 'can_convert' ? job.value : null))

function handlePrevious(): void {
  emit('step', -1)
}

function handleNext(): void {
  emit('step', 1)
}

function handleToggle(): void {
  emit('toggle-selected')
}

function handleConvert(): void {
  emit('convert')
}

function handleSkip(): void {
  if (job.value) emit('skip', job.value)
}

function handleConvertNow(): void {
  if (job.value) emit('convert-now', job.value)
}

function handleRetry(): void {
  emit('retry-plan')
}

function handleBack(): void {
  emit('back')
}
</script>

<template>
  <div v-if="!item" class="flex min-h-0 flex-col items-center justify-center gap-3 p-10 text-center">
    <p class="text-base font-semibold">{{ t('audioConvert.detail.noneTitle') }}</p>
    <p class="max-w-sm text-sm text-muted-foreground">{{ t('audioConvert.detail.noneDescription') }}</p>
  </div>

  <div v-else class="flex min-h-0 min-w-0 flex-col">
    <div class="flex flex-none items-start gap-3 border-b border-border px-5 py-3.5">
      <Button variant="ghost" size="icon" class="md:hidden" :aria-label="t('audioConvert.detail.back')" @click="handleBack">
        <ChevronLeft class="size-4.5" aria-hidden="true" />
      </Button>
      <div class="min-w-0 flex-1">
        <h2 class="truncate font-serif text-xl leading-7 font-semibold tracking-tight">{{ item.title }}</h2>
        <p class="mt-0.5 truncate text-sm text-muted-foreground">
          {{ authors || t('audioConvert.rail.unknownAuthor') }}
          <span v-if="item.status === 'can_convert' && !selected" class="ms-2 font-semibold text-warning">{{
            t('audioConvert.detail.leftOut')
          }}</span>
        </p>
      </div>
      <Button as="router-link" :to="{ name: 'book-detail', params: { bookId: item.bookId } }" variant="outline">
        <ExternalLink class="size-3.5" aria-hidden="true" />
        <span class="hidden sm:inline">{{ t('audioConvert.detail.openBook') }}</span>
      </Button>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-6">
      <!-- Waiting: the automatic pipeline for a newly added book. -->
      <template v-if="item.status === 'waiting'">
        <h3 class="mb-2 text-xs font-medium text-muted-foreground">{{ t('audioConvert.pipeline.title') }}</h3>
        <ol class="overflow-hidden rounded-md border border-border">
          <li
            v-for="(step, stepIndex) in PIPELINE"
            :key="step"
            class="flex items-center gap-2.5 px-3 py-2 text-sm"
            :class="{ 'border-t border-border': stepIndex > 0, 'bg-primary/8': stepIndex === pipelineAt }"
          >
            <span
              class="grid size-5 shrink-0 place-items-center rounded-xs border text-[0.6875rem] font-semibold tabular-nums"
              :class="
                stepIndex < pipelineAt
                  ? 'border-success/40 text-success'
                  : stepIndex === pipelineAt
                    ? 'border-primary/50 text-primary'
                    : 'border-border text-muted-foreground'
              "
            >
              <Check v-if="stepIndex < pipelineAt" class="size-3" aria-hidden="true" />
              <template v-else>{{ stepIndex + 1 }}</template>
            </span>
            <span class="flex-1" :class="stepIndex === pipelineAt ? 'font-semibold' : stepIndex < pipelineAt ? 'text-muted-foreground' : ''">
              {{ t(step) }}
            </span>
            <span v-if="stepIndex === pipelineAt" class="text-xs text-muted-foreground">{{ nextStep || t(stageKey(job?.stage ?? null)) }}</span>
          </li>
        </ol>
        <p class="mt-3 text-xs text-muted-foreground">{{ t('audioConvert.pipeline.help') }}</p>
      </template>

      <!-- Converted and Can't: the files and the reason. -->
      <template v-else-if="item.status !== 'can_convert'">
        <h3 class="mb-2 text-xs font-medium text-muted-foreground">{{ t('audioConvert.detail.files') }}</h3>
        <div v-if="planLoading && !plan" class="space-y-1.5 rounded-md border border-border px-3 py-2.5">
          <Skeleton v-for="n in Math.min(item.fileCount || 1, FILE_LIMIT)" :key="n" class="h-4 w-3/4" />
        </div>
        <div v-else class="rounded-md border border-border px-3 py-2 font-mono text-xs leading-6 break-all">
          <div v-for="file in shownFiles" :key="file.fileId">{{ file.relativePath }}</div>
          <div v-if="hiddenFiles" class="font-sans text-muted-foreground">{{ t('audioConvert.detail.moreFiles', { count: hiddenFiles }) }}</div>
          <div v-if="!plan" class="font-sans text-muted-foreground">{{ item.relativeFolder }}</div>
        </div>
        <p
          class="mt-3 rounded-md px-3 py-2 text-sm"
          :class="item.status === 'cannot' ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'"
        >
          {{ reasonText }}
        </p>
      </template>

      <!-- Can convert: what will happen. -->
      <template v-else>
        <div
          v-if="failedJob"
          class="mb-4 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <AlertTriangle class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <p>{{ t('audioConvert.detail.lastFailed') }} {{ t(errorKey(failedJob.errorCode)) }}</p>
        </div>

        <div v-if="planFailed && !plan" class="flex flex-col items-start gap-2 rounded-md border border-border px-3 py-3 text-sm">
          <p class="text-destructive">{{ t('audioConvert.detail.planFailed') }}</p>
          <Button variant="outline" size="sm" @click="handleRetry">{{ t('common.retry') }}</Button>
        </div>

        <template v-else>
          <h3 class="mb-2 text-xs font-medium text-muted-foreground">{{ t('audioConvert.detail.files') }}</h3>
          <div class="overflow-hidden rounded-md border border-border font-mono text-xs">
            <template v-if="plan">
              <div v-for="file in shownFiles" :key="file.fileId" class="flex flex-wrap gap-x-2 border-b border-border px-3 py-1.5 text-destructive">
                <span class="break-all">− {{ file.relativePath }}</span>
                <span class="font-sans text-muted-foreground">{{ fileDetail(file) }}</span>
              </div>
              <div v-if="hiddenFiles" class="border-b border-border px-3 py-1.5 font-sans text-muted-foreground">
                {{ t('audioConvert.detail.moreFiles', { count: hiddenFiles }) }}
              </div>
              <div class="flex flex-wrap gap-x-2 px-3 py-1.5 text-success">
                <span class="break-all">+ {{ plan.outputName }}</span>
                <span v-if="outputSize" class="font-sans text-muted-foreground">{{ outputSize }}</span>
              </div>
            </template>
            <template v-else>
              <div v-for="n in Math.min(item.fileCount || 1, FILE_LIMIT) + 1" :key="n" class="border-b border-border px-3 py-1.5 last:border-b-0">
                <Skeleton class="h-4 w-2/3" />
              </div>
            </template>
          </div>

          <h3 class="mt-4.5 mb-2 text-xs font-medium text-muted-foreground">{{ t('audioConvert.detail.whatHappens') }}</h3>
          <dl class="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-y-1.5 text-sm">
            <template v-if="plan">
              <dt class="text-muted-foreground">{{ t('audioConvert.detail.row.audio') }}</dt>
              <dd>
                {{ audioRow.value }}
                <span v-if="audioRow.note" class="text-muted-foreground">· {{ audioRow.note }}</span>
              </dd>
              <dt class="text-muted-foreground">{{ t('audioConvert.detail.row.length') }}</dt>
              <dd class="tabular-nums">{{ lengthRow }}</dd>
              <dt class="text-muted-foreground">{{ t('audioConvert.detail.row.chapters') }}</dt>
              <dd>{{ chaptersRow }}</dd>
              <dt class="text-muted-foreground">{{ t('audioConvert.detail.row.metadata') }}</dt>
              <dd>{{ metadataRow }}</dd>
              <dt class="text-muted-foreground">{{ t('audioConvert.detail.row.positions') }}</dt>
              <dd>{{ positionsRow }}</dd>
              <dt class="text-muted-foreground">{{ t('audioConvert.detail.row.readAlong') }}</dt>
              <dd>{{ readAlongRow }}</dd>
              <dt class="text-muted-foreground">{{ t('audioConvert.detail.row.original') }}</dt>
              <dd>{{ originalRow }}</dd>
            </template>
            <template v-else>
              <template v-for="n in 7" :key="n">
                <Skeleton class="my-0.5 h-4 w-16" />
                <Skeleton class="my-0.5 h-4 w-3/5" />
              </template>
            </template>
          </dl>

          <p class="mt-4 flex items-start gap-2 rounded-md bg-warning/10 px-3 py-2 text-xs text-warning">
            <AlertTriangle class="mt-px size-3.5 shrink-0" aria-hidden="true" />
            {{ t('audioConvert.detail.downloads') }}
          </p>
        </template>
      </template>
    </div>

    <div class="flex flex-none flex-wrap items-center gap-2.5 border-t border-border bg-card/80 px-5 py-2.5 backdrop-blur-sm">
      <span class="text-sm text-muted-foreground tabular-nums max-md:order-first max-md:basis-full">
        <template v-if="item.status === 'can_convert'">{{ t('audioConvert.detail.selectedCount', { count: selectedCount }) }}</template>
        <template v-else>{{ t('audioConvert.detail.position', { index: index + 1, total }) }}</template>
      </span>

      <div class="flex gap-0.5">
        <Button variant="outline" size="icon" :disabled="index <= 0" :aria-label="t('audioConvert.detail.previous')" @click="handlePrevious">
          <ChevronLeft class="size-3.5" aria-hidden="true" />
        </Button>
        <Button variant="outline" size="icon" :disabled="index >= total - 1" :aria-label="t('audioConvert.detail.next')" @click="handleNext">
          <ChevronRight class="size-3.5" aria-hidden="true" />
        </Button>
      </div>

      <span class="hidden flex-1 md:block" />

      <template v-if="item.status === 'can_convert'">
        <Button variant="outline" class="max-md:flex-1" @click="handleToggle">
          <component :is="selected ? EyeOff : Undo2" class="size-3.5" aria-hidden="true" />
          {{ selected ? t('audioConvert.detail.leaveOut') : t('audioConvert.detail.include') }}
        </Button>
        <Button class="max-md:flex-2" :disabled="selectedCount === 0" data-testid="audio-convert-open-confirm" @click="handleConvert">
          <Play class="size-3.5" aria-hidden="true" />
          {{ t('audioConvert.detail.convert', { count: selectedCount }) }}
        </Button>
      </template>

      <template v-else-if="job && job.status === 'waiting'">
        <Button variant="outline" class="max-md:flex-1" :disabled="actingJobId === job.id" @click="handleSkip">
          <SkipForward class="size-3.5" aria-hidden="true" />
          {{ t('audioConvert.pipeline.skip') }}
        </Button>
        <Button class="max-md:flex-1" :disabled="actingJobId === job.id" @click="handleConvertNow">
          <Loader2 v-if="actingJobId === job.id" class="size-3.5 animate-spin" aria-hidden="true" />
          <Zap v-else class="size-3.5" aria-hidden="true" />
          {{ t('audioConvert.pipeline.convertNow') }}
        </Button>
      </template>
    </div>
  </div>
</template>

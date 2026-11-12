<script setup lang="ts">
// Fork: Convert to M4B on the book page's Files tab. Shows the button, the confirm dialog for one
// book, and the running job's stage and progress with Stop. The caller gates it with
// useAudioConvertVisible. Both states share one fixed width, so the hero bar never shifts when
// the plan answers or a job starts.
import { computed, onMounted, ref, toRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { FileAudio, Loader2, Square } from '@lucide/vue'
import type { AudioConvertEncoderOptions, AudioConvertJob, BookDetail } from '@bookorbit/types'

import { AUDIO_CONVERT_OPEN_QUERY, errorKey, stageKey } from '../lib/audio-convert'
import { useAudioConvertEnabled } from '../composables/useAudioConvertEnabled'
import { useBookAudioConvert } from '../composables/useBookAudioConvert'
import { useAudioConvertSettings } from '../composables/useAudioConvertSettings'
import AudioConvertConfirmDialog from './AudioConvertConfirmDialog.vue'

const props = defineProps<{ book: BookDetail }>()
const emit = defineEmits<{ converted: [] }>()

const { t } = useI18n()
const convertSettings = useAudioConvertSettings()
const { encoder } = useAudioConvertEnabled()
const bookId = computed<number | null>(() => props.book.id)

function handleConverted(): void {
  toast.success(t('audioConvert.book.done'))
  emit('converted')
}

function handleFailed(failed: AudioConvertJob): void {
  toast.error(t('audioConvert.book.failed'), { description: t(errorKey(failed.errorCode)) })
}

const convert = useBookAudioConvert(
  toRef(() => bookId.value),
  { onConverted: handleConverted, onFailed: handleFailed },
)

const confirmOpen = ref(false)

onMounted(() => {
  void convertSettings.load()
  void convert.load()
})

watch(bookId, () => void convert.load())

const plan = convert.plan
const job = convert.job
const running = computed(() => convert.active.value)

/**
 * The button is drawn from the book's own files so it is there with the rest of the bar; the plan
 * only decides whether it is usable, which never changes its size.
 */
const unavailableReason = computed(() => {
  const value = plan.value
  if (!value) return convert.loadFailed.value ? t('audioConvert.book.planFailed') : null
  if (value.status === 'converted') return t('audioConvert.book.alreadyConverted')
  if (value.status === 'cannot') return value.reason ? t(`audioConvert.reason.${value.reason}`) : t('audioConvert.reason.unknown')
  return null
})

const canOpen = computed(() => !!plan.value && unavailableReason.value === null && !running.value && !convert.starting.value)

const statusText = computed(() => {
  const current = job.value
  if (!current) return ''
  if (current.status === 'waiting') return t('audioConvert.book.waiting')
  if (current.status === 'queued') return t('audioConvert.book.queued')
  const parts = [t(stageKey(current.stage))]
  if (current.progress != null) parts.push(`${Math.round(current.progress)}%`)
  return parts.join(' · ')
})

const readAlongRebuilt = computed(() => !!plan.value?.hasReadAlong && (plan.value?.files.length ?? 0) > 1)

const failedNote = computed(() => (job.value?.status === 'failed' && !running.value ? t(errorKey(job.value.errorCode)) : ''))

function handleOpen(): void {
  if (canOpen.value) confirmOpen.value = true
}

function handleCancel(): void {
  confirmOpen.value = false
}

/** The ⋮ menus send the book here with `?convert=1`; open the dialog once the plan says whether it can. */
const route = useRoute()
const router = useRouter()
watch(
  () => [route.query[AUDIO_CONVERT_OPEN_QUERY], plan.value, convert.loadFailed.value] as const,
  ([flag]) => {
    if (flag !== '1' || (!plan.value && !convert.loadFailed.value)) return
    const rest = { ...route.query }
    delete rest[AUDIO_CONVERT_OPEN_QUERY]
    void router.replace({ query: rest })
    if (canOpen.value) confirmOpen.value = true
    else if (running.value) toast.info(statusText.value)
    else toast.error(unavailableReason.value ?? t('audioConvert.book.planFailed'))
  },
  { immediate: true },
)

async function handleConfirm(options: Partial<AudioConvertEncoderOptions>): Promise<void> {
  const ok = await convert.convert(options)
  confirmOpen.value = false
  if (ok) toast.success(t('audioConvert.book.started'))
  else toast.error(t('audioConvert.toast.runFailed'))
}

async function handleStop(): Promise<void> {
  if (!(await convert.stop())) toast.error(t('audioConvert.toast.stopFailed'))
}
</script>

<template>
  <div class="inline-flex w-48 shrink-0 items-center gap-2" data-testid="audio-convert-book-control">
    <template v-if="running">
      <span
        class="inline-flex h-[34px] min-w-0 flex-1 items-center gap-1.5 rounded-md border border-input px-3 text-[13px] text-muted-foreground"
        role="status"
        data-testid="audio-convert-book-status"
      >
        <Loader2 class="size-4 shrink-0 animate-spin text-primary motion-reduce:animate-none" aria-hidden="true" />
        <span class="truncate tabular-nums">{{ statusText }}</span>
      </span>
      <button
        type="button"
        class="inline-flex size-[34px] shrink-0 items-center justify-center rounded-md border border-input text-foreground transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-progress"
        :disabled="convert.stopping.value"
        :aria-label="t('audioConvert.book.stop')"
        :title="t('audioConvert.book.stop')"
        data-testid="audio-convert-book-stop"
        @click="handleStop"
      >
        <Square class="size-3.5" aria-hidden="true" />
      </button>
    </template>
    <button
      v-else
      type="button"
      class="inline-flex h-[34px] w-full items-center justify-center gap-1.5 rounded-md border border-input px-3 text-[13px] font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      :class="canOpen ? 'text-foreground hover:bg-muted' : 'cursor-not-allowed text-muted-foreground'"
      :aria-disabled="canOpen ? undefined : 'true'"
      :title="unavailableReason ?? (failedNote || undefined)"
      data-testid="audio-convert-book-button"
      @click="handleOpen"
    >
      <FileAudio class="size-4 shrink-0" :class="canOpen ? 'text-primary' : undefined" aria-hidden="true" />
      <span class="truncate">{{ t('audioConvert.book.action') }}</span>
    </button>

    <AudioConvertConfirmDialog
      :open="confirmOpen"
      :count="1"
      :defaults="encoder"
      :backup-days="convertSettings.backupDays.value"
      :busy="convert.starting.value"
      :read-along-rebuilt="readAlongRebuilt"
      @confirm="handleConfirm"
      @cancel="handleCancel"
    />
  </div>
</template>

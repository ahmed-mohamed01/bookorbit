<script setup lang="ts">
// Fork: Convert to M4B. Confirm dialog with this run's encoder options.
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2, Play } from '@lucide/vue'
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import { AUDIO_CONVERT_BITRATES, type AudioConvertBitrate, type AudioConvertCodec, type AudioConvertEncoderOptions } from '@bookorbit/types'

import { Button } from '@/components/ui/button'
import { channelsFromValue, channelsToValue, FALLBACK_ENCODER_OPTIONS, type ChannelsValue } from '../lib/audio-convert'
import AudioConvertSegmented from './AudioConvertSegmented.vue'

const props = defineProps<{
  open: boolean
  count: number
  /** The admin's saved codec, bitrate and channels, or `null` until they arrive. */
  defaults: AudioConvertEncoderOptions | null
  /** Saved backup window, or `null` when the viewer cannot read settings. */
  backupDays: number | null
  busy?: boolean
  /** The single book being converted is merged and has a read-along index that will be rebuilt. */
  readAlongRebuilt?: boolean
}>()

const emit = defineEmits<{
  /** Only the fields the user changed; the server fills the rest from the saved settings. */
  confirm: [options: Partial<AudioConvertEncoderOptions>]
  cancel: []
}>()

const { t } = useI18n()

const shown = computed<AudioConvertEncoderOptions>(() => props.defaults ?? FALLBACK_ENCODER_OPTIONS)
const codec = ref<AudioConvertCodec>(shown.value.codec)
const bitrate = ref<AudioConvertBitrate>(shown.value.bitrate)
const channels = ref<ChannelsValue>(channelsToValue(shown.value.channels))
/** Fields the user picked in this opening. Untouched ones follow the saved defaults, even late ones. */
const touched = ref<Set<keyof AudioConvertEncoderOptions>>(new Set())

function syncUntouched(): void {
  if (!touched.value.has('codec')) codec.value = shown.value.codec
  if (!touched.value.has('bitrate')) bitrate.value = shown.value.bitrate
  if (!touched.value.has('channels')) channels.value = channelsToValue(shown.value.channels)
}

function touch(field: keyof AudioConvertEncoderOptions): void {
  touched.value = new Set(touched.value).add(field)
}

// Every opening starts from the saved defaults, so one run's choice does not leak into the next.
watch(
  () => props.open,
  (open) => {
    if (!open) return
    touched.value = new Set()
    syncUntouched()
  },
)
// Defaults that arrive while the dialog is open replace only what the user has not picked. The
// controls keep their size, so only the shown value changes.
watch(shown, syncUntouched)

const codecOptions = computed(() => [
  { value: 'auto' as const, label: t('audioConvert.codec.auto') },
  { value: 'copy' as const, label: t('audioConvert.codec.copy') },
  { value: 'aac' as const, label: t('audioConvert.codec.aac') },
])

const codecHint = computed(() => t(`audioConvert.codecHint.${codec.value}`))
/** Bitrate and channels only matter when audio is re-encoded, which Copy never does. */
const encoderDisabled = computed(() => codec.value === 'copy')

const description = computed(() => {
  if (props.backupDays === null) return t('audioConvert.confirm.bodyUnknownBackup')
  if (props.backupDays === 0) return t('audioConvert.confirm.bodyNoBackup')
  return t('audioConvert.confirm.body', { days: props.backupDays })
})

function handleOpenChange(open: boolean): void {
  if (!open && !props.busy) emit('cancel')
}

function handleCodec(value: AudioConvertCodec): void {
  codec.value = value
  touch('codec')
}

function handleBitrate(event: Event): void {
  bitrate.value = (event.target as HTMLSelectElement).value as AudioConvertBitrate
  touch('bitrate')
}

function handleChannels(event: Event): void {
  channels.value = (event.target as HTMLSelectElement).value as ChannelsValue
  touch('channels')
}

function handleConfirm(): void {
  const options: Partial<AudioConvertEncoderOptions> = {}
  if (touched.value.has('codec')) options.codec = codec.value
  if (touched.value.has('bitrate')) options.bitrate = bitrate.value
  if (touched.value.has('channels')) options.channels = channelsFromValue(channels.value)
  emit('confirm', options)
}

function handleCancel(): void {
  if (!props.busy) emit('cancel')
}
</script>

<template>
  <DialogRoot :open="open" @update:open="handleOpenChange">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-scrim" />
      <DialogContent
        class="fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-popover p-5 shadow-2xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        data-testid="audio-convert-confirm"
      >
        <DialogTitle class="text-base font-semibold">{{ t('audioConvert.confirm.title', { count }) }}</DialogTitle>
        <DialogDescription class="mt-1.5 text-sm leading-relaxed text-muted-foreground">{{ description }}</DialogDescription>

        <p class="mt-4 mb-1.5 text-xs font-medium text-muted-foreground">{{ t('audioConvert.confirm.audio') }}</p>
        <AudioConvertSegmented
          :model-value="codec"
          :options="codecOptions"
          :label="t('audioConvert.confirm.audio')"
          @update:model-value="handleCodec"
        />
        <p class="mt-1.5 min-h-8 text-xs text-muted-foreground">{{ codecHint }}</p>

        <div class="mt-2 flex flex-wrap gap-4" :class="{ 'opacity-50': encoderDisabled }">
          <label class="grid gap-1 text-xs text-muted-foreground">
            {{ t('audioConvert.confirm.bitrate') }}
            <select
              :value="bitrate"
              :disabled="encoderDisabled"
              class="h-8 w-28 rounded-md border border-border bg-background px-2 text-sm text-foreground focus:ring-2 focus:ring-primary/50 focus:outline-none disabled:cursor-not-allowed"
              @change="handleBitrate"
            >
              <option v-for="value in AUDIO_CONVERT_BITRATES" :key="value" :value="value">{{ value }}</option>
            </select>
          </label>
          <label class="grid gap-1 text-xs text-muted-foreground">
            {{ t('audioConvert.confirm.channels') }}
            <select
              :value="channels"
              :disabled="encoderDisabled"
              class="h-8 w-28 rounded-md border border-border bg-background px-2 text-sm text-foreground focus:ring-2 focus:ring-primary/50 focus:outline-none disabled:cursor-not-allowed"
              @change="handleChannels"
            >
              <option value="keep">{{ t('audioConvert.channels.keep') }}</option>
              <option value="1">{{ t('audioConvert.channels.mono') }}</option>
              <option value="2">{{ t('audioConvert.channels.stereo') }}</option>
            </select>
          </label>
        </div>

        <p v-if="readAlongRebuilt" class="mt-4 rounded-md bg-warning/10 px-3 py-2 text-xs text-warning">
          {{ t('audioConvert.confirm.readAlong') }}
        </p>
        <p class="mt-3 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">{{ t('audioConvert.confirm.downloads') }}</p>

        <div class="mt-4 flex flex-wrap justify-end gap-2">
          <Button variant="outline" :disabled="busy" @click="handleCancel">{{ t('common.cancel') }}</Button>
          <Button :disabled="busy || count === 0" data-testid="audio-convert-confirm-go" @click="handleConfirm">
            <Loader2 v-if="busy" class="size-3.5 animate-spin" aria-hidden="true" />
            <Play v-else class="size-3.5" aria-hidden="true" />
            {{ t('audioConvert.confirm.go', { count }) }}
          </Button>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

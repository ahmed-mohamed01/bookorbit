<script setup lang="ts">
// Fork: Settings › Fork › Audio conversion. Admin only; follows EditionSyncAdminSettings.
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Loader2, Save } from '@lucide/vue'
import {
  AUDIO_CONVERT_BACKUP_DAYS_MAX,
  AUDIO_CONVERT_BACKUP_DAYS_MIN,
  AUDIO_CONVERT_BITRATES,
  AUDIO_CONVERT_NEW_BOOK_QUIET_MINUTES,
  type AudioConvertBitrate,
  type AudioConvertCodec,
  type UpdateAudioConvertSettingsPayload,
} from '@bookorbit/types'

import { Button } from '@/components/ui/button'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import { useAudioConvertSettings } from '../composables/useAudioConvertSettings'
import { channelsFromValue, FALLBACK_BACKUP_DAYS, mergeSavedSettings, type AudioConvertSettingsForm, type ChannelsValue } from '../lib/audio-convert'
import AudioConvertSegmented from './AudioConvertSegmented.vue'

const { t } = useI18n()
const { settings, loading, saving, error, load, save } = useAudioConvertSettings()

const enabled = ref(false)
const autoConvert = ref(false)
const codec = ref<AudioConvertCodec>('auto')
const bitrate = ref<AudioConvertBitrate>('128k')
const channels = ref<ChannelsValue>('keep')
const embedChapters = ref(true)
const embedMetadata = ref(true)
const backupDays = ref<number>(FALLBACK_BACKUP_DAYS)
const confirmNoBackupOpen = ref(false)

function currentForm(): AudioConvertSettingsForm {
  return {
    enabled: enabled.value,
    autoConvert: autoConvert.value,
    codec: codec.value,
    bitrate: bitrate.value,
    channels: channels.value,
    embedChapters: embedChapters.value,
    embedMetadata: embedMetadata.value,
    backupDays: backupDays.value,
  }
}

function applyForm(form: AudioConvertSettingsForm): void {
  enabled.value = form.enabled
  autoConvert.value = form.autoConvert
  codec.value = form.codec
  bitrate.value = form.bitrate
  channels.value = form.channels
  embedChapters.value = form.embedChapters
  embedMetadata.value = form.embedMetadata
  backupDays.value = form.backupDays
}

// A reload (or a save) only moves the fields the admin has not touched, so edits in progress stay.
watch(
  settings,
  (value, previous) => {
    if (value) applyForm(mergeSavedSettings(currentForm(), previous ?? null, value))
  },
  { immediate: true },
)

onMounted(() => void load(true))

const codecOptions = computed(() => [
  { value: 'auto' as const, label: t('audioConvert.codec.auto') },
  { value: 'copy' as const, label: t('audioConvert.codec.copy') },
  { value: 'aac' as const, label: t('audioConvert.codec.aac') },
])

const backupValid = computed(
  () => Number.isInteger(backupDays.value) && backupDays.value >= AUDIO_CONVERT_BACKUP_DAYS_MIN && backupDays.value <= AUDIO_CONVERT_BACKUP_DAYS_MAX,
)

const payload = computed<UpdateAudioConvertSettingsPayload>(() => ({
  enabled: enabled.value,
  autoConvert: autoConvert.value,
  codec: codec.value,
  bitrate: bitrate.value,
  channels: channelsFromValue(channels.value),
  embedChapters: embedChapters.value,
  embedMetadata: embedMetadata.value,
  backupDays: backupDays.value,
}))

const dirty = computed(() => {
  const saved = settings.value
  if (!saved) return false
  const next = payload.value
  return (
    saved.enabled !== next.enabled ||
    saved.autoConvert !== next.autoConvert ||
    saved.codec !== next.codec ||
    saved.bitrate !== next.bitrate ||
    saved.channels !== next.channels ||
    saved.embedChapters !== next.embedChapters ||
    saved.embedMetadata !== next.embedMetadata ||
    saved.backupDays !== next.backupDays
  )
})

function handleCodec(value: AudioConvertCodec): void {
  codec.value = value
}

function handleBitrate(event: Event): void {
  bitrate.value = (event.target as HTMLSelectElement).value as AudioConvertBitrate
}

function handleChannels(event: Event): void {
  channels.value = (event.target as HTMLSelectElement).value as ChannelsValue
}

function handleBackupDays(event: Event): void {
  const raw = (event.target as HTMLInputElement).value
  backupDays.value = raw === '' ? Number.NaN : Number(raw)
}

async function persist(): Promise<void> {
  const ok = await save(payload.value)
  if (ok) toast.success(t('audioConvert.settings.toast.saved'))
  else
    toast.error(t('audioConvert.settings.toast.failed'), {
      description: error.value ? t('audioConvert.view.httpError', { status: error.value }) : undefined,
    })
}

/** Turning backups off deletes originals as soon as a conversion is verified, so it asks first. */
async function handleSave(): Promise<void> {
  if (backupDays.value === 0 && settings.value?.backupDays !== 0) {
    confirmNoBackupOpen.value = true
    return
  }
  await persist()
}

async function handleConfirmNoBackup(): Promise<void> {
  await persist()
  confirmNoBackupOpen.value = false
}

function handleCancelNoBackup(): void {
  confirmNoBackupOpen.value = false
}
</script>

<template>
  <div class="space-y-4">
    <div v-if="loading" class="settings-loading-state">
      <Loader2 class="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
    </div>

    <p v-else-if="!settings && error !== null" class="text-sm text-destructive">{{ t('audioConvert.settings.loadFailed') }}</p>

    <section
      v-else-if="settings"
      class="divide-y divide-border rounded-lg border border-border bg-card shadow-xs"
      data-testid="audio-convert-settings"
    >
      <div class="flex flex-col gap-2 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div class="min-w-0">
          <p id="audio-convert-enabled-label" class="text-sm">{{ t('audioConvert.settings.enabled.title') }}</p>
          <p id="audio-convert-enabled-help" class="mt-0.5 text-xs text-muted-foreground">{{ t('audioConvert.settings.enabled.help') }}</p>
        </div>
        <ToggleSwitch v-model="enabled" aria-labelledby="audio-convert-enabled-label" aria-describedby="audio-convert-enabled-help" />
      </div>

      <div class="flex flex-col gap-2 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div class="min-w-0">
          <p id="audio-convert-auto-label" class="text-sm">{{ t('audioConvert.settings.auto.title') }}</p>
          <p id="audio-convert-auto-help" class="mt-0.5 text-xs text-muted-foreground">
            {{ t('audioConvert.settings.auto.help', { minutes: AUDIO_CONVERT_NEW_BOOK_QUIET_MINUTES }) }}
          </p>
        </div>
        <ToggleSwitch v-model="autoConvert" aria-labelledby="audio-convert-auto-label" aria-describedby="audio-convert-auto-help" />
      </div>

      <div class="flex flex-col gap-2 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div class="min-w-0">
          <p class="text-sm">{{ t('audioConvert.settings.codec.title') }}</p>
          <p class="mt-0.5 text-xs text-muted-foreground">{{ t('audioConvert.settings.codec.help') }}</p>
        </div>
        <AudioConvertSegmented
          class="shrink-0"
          :model-value="codec"
          :options="codecOptions"
          :label="t('audioConvert.settings.codec.title')"
          @update:model-value="handleCodec"
        />
      </div>

      <div class="flex flex-col gap-2 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div class="min-w-0">
          <p class="text-sm">{{ t('audioConvert.settings.encoder.title') }}</p>
          <p class="mt-0.5 text-xs text-muted-foreground">{{ t('audioConvert.settings.encoder.help') }}</p>
        </div>
        <div class="flex shrink-0 gap-2">
          <select
            :value="bitrate"
            :aria-label="t('audioConvert.confirm.bitrate')"
            class="w-24 rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:ring-2 focus:ring-primary/50 focus:outline-none"
            @change="handleBitrate"
          >
            <option v-for="value in AUDIO_CONVERT_BITRATES" :key="value" :value="value">{{ value }}</option>
          </select>
          <select
            :value="channels"
            :aria-label="t('audioConvert.confirm.channels')"
            class="w-24 rounded-md border border-border bg-background px-2 py-1.5 text-sm focus:ring-2 focus:ring-primary/50 focus:outline-none"
            @change="handleChannels"
          >
            <option value="keep">{{ t('audioConvert.channels.keep') }}</option>
            <option value="1">{{ t('audioConvert.channels.mono') }}</option>
            <option value="2">{{ t('audioConvert.channels.stereo') }}</option>
          </select>
        </div>
      </div>

      <div class="flex flex-col gap-2 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div class="min-w-0">
          <p id="audio-convert-chapters-label" class="text-sm">{{ t('audioConvert.settings.embedChapters.title') }}</p>
          <p id="audio-convert-chapters-help" class="mt-0.5 text-xs text-muted-foreground">{{ t('audioConvert.settings.embedChapters.help') }}</p>
        </div>
        <ToggleSwitch v-model="embedChapters" aria-labelledby="audio-convert-chapters-label" aria-describedby="audio-convert-chapters-help" />
      </div>

      <div class="flex flex-col gap-2 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div class="min-w-0">
          <p id="audio-convert-metadata-label" class="text-sm">{{ t('audioConvert.settings.embedMetadata.title') }}</p>
          <p id="audio-convert-metadata-help" class="mt-0.5 text-xs text-muted-foreground">{{ t('audioConvert.settings.embedMetadata.help') }}</p>
        </div>
        <ToggleSwitch v-model="embedMetadata" aria-labelledby="audio-convert-metadata-label" aria-describedby="audio-convert-metadata-help" />
      </div>

      <div class="flex flex-col gap-2 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div class="min-w-0">
          <label for="audio-convert-backup-days" class="text-sm">{{ t('audioConvert.settings.backupDays.title') }}</label>
          <p id="audio-convert-backup-help" class="mt-0.5 text-xs" :class="backupValid ? 'text-muted-foreground' : 'text-destructive'">
            {{
              backupValid
                ? t('audioConvert.settings.backupDays.help')
                : t('audioConvert.settings.backupDays.invalid', { max: AUDIO_CONVERT_BACKUP_DAYS_MAX })
            }}
          </p>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <input
            id="audio-convert-backup-days"
            type="number"
            inputmode="numeric"
            :min="AUDIO_CONVERT_BACKUP_DAYS_MIN"
            :max="AUDIO_CONVERT_BACKUP_DAYS_MAX"
            step="1"
            :value="Number.isNaN(backupDays) ? '' : backupDays"
            aria-describedby="audio-convert-backup-help"
            :aria-invalid="backupValid ? undefined : 'true'"
            class="w-20 rounded-md border border-border bg-background px-2 py-1.5 text-sm tabular-nums focus:ring-2 focus:ring-primary/50 focus:outline-none"
            @input="handleBackupDays"
          />
          <span class="text-sm text-muted-foreground">{{ t('audioConvert.settings.backupDays.unit') }}</span>
        </div>
      </div>

      <div class="flex justify-end px-4 py-3">
        <Button size="sm" type="button" :disabled="saving || !dirty || !backupValid" data-testid="audio-convert-settings-save" @click="handleSave">
          <Loader2 v-if="saving" class="size-3.5 animate-spin" />
          <Save v-else class="size-3.5" />
          {{ t('common.save') }}
        </Button>
      </div>
    </section>

    <ConfirmDialog
      :open="confirmNoBackupOpen"
      :title="t('audioConvert.settings.noBackupDialog.title')"
      :description="t('audioConvert.settings.noBackupDialog.description')"
      :confirm-label="t('audioConvert.settings.noBackupDialog.confirm')"
      :busy="saving"
      @confirm="handleConfirmNoBackup"
      @cancel="handleCancelNoBackup"
    />
  </div>
</template>

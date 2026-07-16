<script setup lang="ts">
import { onMounted, reactive, watch } from 'vue'
import { Loader2, Save } from '@lucide/vue'
import { toast } from 'vue-sonner'
import type { UpsertAudiobookshelfSettingsPayload } from '@bookorbit/types'
import SettingsPageHeader from '@/features/settings/SettingsPageHeader.vue'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import AudiobookshelfConnectionCard from './AudiobookshelfConnectionCard.vue'
import AudiobookshelfLinkedBooks from './AudiobookshelfLinkedBooks.vue'
import AudiobookshelfSyncProgress from './AudiobookshelfSyncProgress.vue'
import { useAudiobookshelfSettings } from '../composables/useAudiobookshelfSettings'

const props = withDefaults(defineProps<{ embedded?: boolean }>(), { embedded: false })
const { settings, saving, error, fetchSettings, saveSettings } = useAudiobookshelfSettings()

const syncOptions = reactive({ syncStatus: true, syncPosition: true, syncSessions: true })

watch(
  settings,
  (value) => {
    if (!value) return
    syncOptions.syncStatus = value.syncStatus
    syncOptions.syncPosition = value.syncPosition
    syncOptions.syncSessions = value.syncSessions
  },
  { immediate: true },
)

onMounted(async () => {
  if (!settings.value) await fetchSettings()
})

async function handleSaveSyncOptions(): Promise<void> {
  const payload: UpsertAudiobookshelfSettingsPayload = {
    ...(syncOptions.syncStatus !== settings.value?.syncStatus ? { syncStatus: syncOptions.syncStatus } : {}),
    ...(syncOptions.syncPosition !== settings.value?.syncPosition ? { syncPosition: syncOptions.syncPosition } : {}),
    ...(syncOptions.syncSessions !== settings.value?.syncSessions ? { syncSessions: syncOptions.syncSessions } : {}),
  }
  const saved = await saveSettings(payload)
  if (saved) toast.success('Audiobookshelf sync options saved')
  else toast.error(error.value ?? 'Failed to save Audiobookshelf sync options')
}
</script>

<template>
  <div class="space-y-6">
    <SettingsPageHeader
      v-if="!props.embedded"
      title="Audiobookshelf"
      subtitle="Pull listening status, playback position, and sessions from Audiobookshelf."
    />

    <AudiobookshelfConnectionCard />
    <AudiobookshelfSyncProgress v-if="settings?.tokenConfigured" />

    <section v-if="settings?.tokenConfigured" class="space-y-4 rounded-lg border border-border bg-card px-4 py-4 shadow-xs md:px-5 md:py-5">
      <div>
        <p class="text-sm font-medium">Data to sync</p>
        <p class="mt-0.5 text-xs text-muted-foreground">Choose which Audiobookshelf activity BookOrbit imports.</p>
      </div>

      <div class="space-y-4">
        <div class="flex items-center justify-between gap-4">
          <div>
            <p class="text-sm">Reading status</p>
            <p class="mt-0.5 text-xs text-muted-foreground">Promote books to reading or read without downgrading local status.</p>
          </div>
          <ToggleSwitch v-model="syncOptions.syncStatus" :disabled="!settings.enabled" />
        </div>
        <div class="flex items-center justify-between gap-4">
          <div>
            <p class="text-sm">Playback position</p>
            <p class="mt-0.5 text-xs text-muted-foreground">Resume BookOrbit audiobooks from the latest Audiobookshelf position.</p>
          </div>
          <ToggleSwitch v-model="syncOptions.syncPosition" :disabled="!settings.enabled" />
        </div>
        <div class="flex items-center justify-between gap-4">
          <div>
            <p class="text-sm">Listening sessions</p>
            <p class="mt-0.5 text-xs text-muted-foreground">Import listening time into reading statistics and achievements.</p>
          </div>
          <ToggleSwitch v-model="syncOptions.syncSessions" :disabled="!settings.enabled" />
        </div>
      </div>

      <div class="flex justify-end border-t border-border pt-3">
        <button
          type="button"
          :disabled="saving"
          class="flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
          @click="handleSaveSyncOptions"
        >
          <Loader2 v-if="saving" class="size-3.5 animate-spin" />
          <Save v-else class="size-3.5" />
          Save sync options
        </button>
      </div>
    </section>

    <AudiobookshelfLinkedBooks v-if="settings?.tokenConfigured" />
  </div>
</template>

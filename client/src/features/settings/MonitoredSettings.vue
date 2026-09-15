<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { CalendarClock, Loader2, RefreshCw } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import type { MonitoredSettings, UpdateMonitoredSettingsRequest } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import { api } from '@/lib/api'
import SettingsPageHeader from './SettingsPageHeader.vue'

const { t } = useI18n()
const props = withDefaults(defineProps<{ embedded?: boolean }>(), { embedded: false })

const refreshCooldownMinutes = ref(10)
const savedRefreshCooldownMinutes = ref(10)
const syncEnabled = ref(true)
const savedSyncEnabled = ref(true)
const syncIntervalHours = ref(12)
const savedSyncIntervalHours = ref(12)
const loading = ref(true)
const saving = ref(false)

const dirty = computed(
  () =>
    refreshCooldownMinutes.value !== savedRefreshCooldownMinutes.value ||
    syncEnabled.value !== savedSyncEnabled.value ||
    syncIntervalHours.value !== savedSyncIntervalHours.value,
)

function applySettings(settings: MonitoredSettings) {
  refreshCooldownMinutes.value = settings.refreshCooldownMinutes
  savedRefreshCooldownMinutes.value = settings.refreshCooldownMinutes
  syncEnabled.value = settings.syncEnabled
  savedSyncEnabled.value = settings.syncEnabled
  syncIntervalHours.value = settings.syncIntervalHours
  savedSyncIntervalHours.value = settings.syncIntervalHours
}

async function loadSettings() {
  try {
    const response = await api('/api/v1/monitored/settings')
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    applySettings(await response.json())
  } catch {
    toast.error(t('settings.system.monitored.loadFailed'))
  } finally {
    loading.value = false
  }
}

async function saveSettings() {
  const value = refreshCooldownMinutes.value
  if (!Number.isInteger(value) || value < 1 || value > 1440) {
    toast.error(t('settings.system.monitored.invalidCooldown'))
    return
  }
  const interval = syncIntervalHours.value
  if (!Number.isInteger(interval) || interval < 1 || interval > 168) {
    toast.error(t('settings.system.monitored.invalidInterval'))
    return
  }

  saving.value = true
  const payload: UpdateMonitoredSettingsRequest = {
    refreshCooldownMinutes: value,
    syncEnabled: syncEnabled.value,
    syncIntervalHours: interval,
  }
  try {
    const response = await api('/api/v1/monitored/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    applySettings(await response.json())
    toast.success(t('settings.system.monitored.saved'))
  } catch {
    toast.error(t('settings.system.monitored.saveFailed'))
  } finally {
    saving.value = false
  }
}

onMounted(loadSettings)
</script>

<template>
  <SettingsPageHeader
    v-if="!props.embedded"
    class="hidden md:flex"
    :title="t('settings.system.monitored.title')"
    :subtitle="t('settings.system.monitored.subtitle')"
  />

  <div v-if="loading" class="settings-loading-state" :class="{ 'mt-5 md:mt-0': !props.embedded }">
    <Loader2 class="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
  </div>

  <div v-else class="space-y-4" :class="{ 'mt-5 md:mt-0': !props.embedded }">
    <section aria-labelledby="monitored-refresh-heading" class="space-y-2">
      <h2 id="monitored-refresh-heading" class="settings-group-label">
        {{ t('settings.system.monitored.refreshGroup') }}
      </h2>
      <div class="settings-card">
        <div class="settings-row">
          <div class="flex items-start gap-3">
            <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
              <RefreshCw :size="16" class="text-primary" aria-hidden="true" />
            </div>
            <div class="min-w-0">
              <label for="monitored-refresh-cooldown" class="settings-label">
                {{ t('settings.system.monitored.refreshCooldown') }}
              </label>
              <p class="settings-hint">
                {{ t('settings.system.monitored.refreshCooldownHint') }}
              </p>
            </div>
          </div>
          <div class="flex items-center gap-3">
            <div class="flex items-center gap-2">
              <input
                id="monitored-refresh-cooldown"
                v-model.number="refreshCooldownMinutes"
                type="number"
                min="1"
                max="1440"
                class="w-24 rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                :disabled="saving"
              />
              <span class="text-sm text-muted-foreground">{{ t('settings.system.monitored.minutes') }}</span>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section aria-labelledby="monitored-sync-heading" class="space-y-2">
      <h2 id="monitored-sync-heading" class="settings-group-label">
        {{ t('settings.system.monitored.syncGroup') }}
      </h2>
      <div class="settings-card">
        <div class="settings-row">
          <div class="flex items-start gap-3">
            <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
              <CalendarClock :size="16" class="text-primary" aria-hidden="true" />
            </div>
            <div class="min-w-0">
              <span id="monitored-sync-enabled-label" class="settings-label">{{ t('settings.system.monitored.syncEnabled') }}</span>
              <p class="settings-hint">
                {{ t('settings.system.monitored.syncEnabledHint') }}
              </p>
            </div>
          </div>
          <ToggleSwitch
            v-model="syncEnabled"
            :disabled="saving"
            aria-labelledby="monitored-sync-enabled-label"
            class="self-start md:self-auto md:ml-4"
          />
        </div>
        <div class="settings-row">
          <div class="min-w-0">
            <label for="monitored-sync-interval" class="settings-label">
              {{ t('settings.system.monitored.syncInterval') }}
            </label>
            <p class="settings-hint">
              {{ t('settings.system.monitored.syncIntervalHint') }}
            </p>
          </div>
          <div class="flex items-center gap-2">
            <input
              id="monitored-sync-interval"
              v-model.number="syncIntervalHours"
              type="number"
              min="1"
              max="168"
              class="w-24 rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
              :disabled="saving || !syncEnabled"
            />
            <span class="text-sm text-muted-foreground">{{ t('settings.system.monitored.hours') }}</span>
          </div>
        </div>
      </div>
    </section>

    <div class="flex justify-end">
      <Button type="button" variant="outline" size="sm" :disabled="saving || !dirty" @click="saveSettings">
        <Loader2 v-if="saving" class="size-4 animate-spin" aria-hidden="true" />
        {{ t('settings.system.monitored.save') }}
      </Button>
    </div>
  </div>
</template>

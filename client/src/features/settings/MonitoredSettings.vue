<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Loader2, RefreshCw } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import type { MonitoredSettings, UpdateMonitoredSettingsRequest } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import SettingsPageHeader from './SettingsPageHeader.vue'

const { t } = useI18n()
const props = withDefaults(defineProps<{ embedded?: boolean }>(), { embedded: false })

const refreshCooldownMinutes = ref(10)
const savedRefreshCooldownMinutes = ref(10)
const loading = ref(true)
const saving = ref(false)

function applySettings(settings: MonitoredSettings) {
  refreshCooldownMinutes.value = settings.refreshCooldownMinutes
  savedRefreshCooldownMinutes.value = settings.refreshCooldownMinutes
}

async function loadSettings() {
  try {
    const response = await api('/api/v1/app-settings/monitored')
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

  saving.value = true
  const payload: UpdateMonitoredSettingsRequest = { refreshCooldownMinutes: value }
  try {
    const response = await api('/api/v1/app-settings/monitored', {
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
            <Button
              type="button"
              variant="outline"
              size="sm"
              :disabled="saving || refreshCooldownMinutes === savedRefreshCooldownMinutes"
              @click="saveSettings"
            >
              <Loader2 v-if="saving" class="size-4 animate-spin" aria-hidden="true" />
              {{ t('settings.system.monitored.save') }}
            </Button>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

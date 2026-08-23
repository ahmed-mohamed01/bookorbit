<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { AlertCircle, CheckCircle2, Eye, EyeOff, Link, Loader2, RefreshCw, Save, Unlink } from '@lucide/vue'
import { toast } from 'vue-sonner'
import type { UpsertAudiobookshelfSettingsPayload } from '@bookorbit/types'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import { SECRET_INPUT_ATTRS } from '@/lib/secret-input'
import { useAudiobookshelfSettings } from '../composables/useAudiobookshelfSettings'
import { useAudiobookshelfSync } from '../composables/useAudiobookshelfSync'

// Settings are fetched by the parent (AudiobookshelfSettings), which owns the lifecycle; this card
// renders from the shared ref. Fetching here too raced the parent's `if (!settings.value)` guard,
// since children mount first, and fired two identical GETs on every mount.
const { settings, loading, saving, testing, error, testError, saveSettings, disconnect, testConnection } = useAudiobookshelfSettings()
const { syncing, isFullResync, syncNow, fullResync } = useAudiobookshelfSync()

const form = reactive({ serverUrl: '', enabled: true })
const tokenInput = ref('')
const tokenVisible = ref(false)
const testResult = ref<{ success: boolean; username?: string; error?: string } | null>(null)

const isConfigured = computed(() => settings.value?.tokenConfigured === true && Boolean(settings.value.serverUrl))
const lastSyncedLabel = computed(() => {
  if (!settings.value?.lastSyncedAt) return 'Never'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(settings.value.lastSyncedAt))
})

watch(
  settings,
  (value) => {
    if (!value) return
    form.serverUrl = value.serverUrl ?? ''
    form.enabled = value.enabled
  },
  { immediate: true },
)

watch([() => form.serverUrl, tokenInput], () => {
  testResult.value = null
})

function toggleTokenVisibility(): void {
  tokenVisible.value = !tokenVisible.value
}

function connectionPayload(): { serverUrl?: string; apiToken?: string } {
  return {
    ...(form.serverUrl.trim() ? { serverUrl: form.serverUrl.trim() } : {}),
    ...(tokenInput.value.trim() ? { apiToken: tokenInput.value.trim() } : {}),
  }
}

function ensureConnectionInput(): boolean {
  if (!form.serverUrl.trim()) {
    toast.error('Enter your Audiobookshelf server URL')
    return false
  }
  if (!tokenInput.value.trim() && !settings.value?.tokenConfigured) {
    toast.error('Enter your Audiobookshelf API token')
    return false
  }
  return true
}

async function handleTestConnection(): Promise<void> {
  if (!ensureConnectionInput()) return
  testResult.value = await testConnection(connectionPayload())
  if (testResult.value.success) toast.success('Audiobookshelf connection successful')
  else toast.error(testResult.value.error ?? testError.value ?? 'Audiobookshelf connection failed')
}

async function handleSave(): Promise<void> {
  if (!ensureConnectionInput()) return
  const payload: UpsertAudiobookshelfSettingsPayload = {
    ...(form.serverUrl.trim() !== settings.value?.serverUrl ? { serverUrl: form.serverUrl.trim() } : {}),
    ...(tokenInput.value.trim() ? { apiToken: tokenInput.value.trim() } : {}),
    ...(form.enabled !== settings.value?.enabled ? { enabled: form.enabled } : {}),
  }
  const saved = await saveSettings(payload)
  if (saved) {
    tokenInput.value = ''
    testResult.value = null
    toast.success('Audiobookshelf connection saved')
  } else {
    toast.error(error.value ?? 'Failed to save Audiobookshelf connection')
  }
}

async function handleDisconnect(): Promise<void> {
  if (await disconnect()) {
    form.serverUrl = ''
    tokenInput.value = ''
    testResult.value = null
    toast.success('Audiobookshelf disconnected')
  } else {
    toast.error(error.value ?? 'Failed to disconnect Audiobookshelf')
  }
}

async function handleSyncNow(): Promise<void> {
  if (await syncNow()) toast.success('Audiobookshelf sync completed')
}

async function handleFullResync(): Promise<void> {
  if (await fullResync()) toast.success('Audiobookshelf full resync completed')
}
</script>

<template>
  <section class="space-y-5 rounded-lg border border-border bg-card px-4 py-4 shadow-xs md:px-5 md:py-5">
    <div class="flex flex-wrap items-start gap-3">
      <Link class="mt-0.5 size-5 shrink-0 text-primary" />
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium">Connection</p>
        <p class="mt-0.5 text-xs text-muted-foreground">Connect BookOrbit to your personal Audiobookshelf server.</p>
      </div>
      <div v-if="isConfigured" data-testid="connection-status" class="flex items-center gap-1.5 text-xs text-primary">
        <CheckCircle2 class="size-3.5" />
        Connected
      </div>
      <div v-else data-testid="connection-status" class="flex items-center gap-1.5 text-xs text-muted-foreground">
        <AlertCircle class="size-3.5" />
        Not configured
      </div>
    </div>

    <div v-if="loading" class="flex items-center gap-2 py-3 text-xs text-muted-foreground">
      <Loader2 class="size-3.5 animate-spin" />
      Loading connection...
    </div>

    <div v-else class="space-y-4">
      <div class="space-y-1.5">
        <label for="audiobookshelf-server-url" class="text-xs font-medium uppercase tracking-wider text-muted-foreground">Server URL</label>
        <input
          id="audiobookshelf-server-url"
          v-model="form.serverUrl"
          type="url"
          inputmode="url"
          placeholder="https://audiobooks.example.com"
          autocomplete="url"
          class="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
        />
      </div>

      <div class="space-y-1.5">
        <label for="audiobookshelf-token" class="text-xs font-medium uppercase tracking-wider text-muted-foreground">API token</label>
        <div class="flex gap-2">
          <input
            id="audiobookshelf-token"
            v-model="tokenInput"
            v-bind="SECRET_INPUT_ATTRS"
            type="text"
            :class="{ 'input-secret': !tokenVisible }"
            :placeholder="isConfigured ? 'Leave blank to keep the saved token' : 'Paste your Audiobookshelf API token'"
            class="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
          <button
            type="button"
            :aria-label="tokenVisible ? 'Hide token' : 'Show token'"
            class="rounded-md border border-border bg-muted px-3 py-2 text-muted-foreground transition-colors hover:bg-muted/80"
            @click="toggleTokenVisibility"
          >
            <EyeOff v-if="tokenVisible" class="size-4" />
            <Eye v-else class="size-4" />
          </button>
        </div>
        <p class="text-xs text-muted-foreground">Find your token in Audiobookshelf under Account settings.</p>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <button
          type="button"
          :disabled="testing || saving"
          class="flex items-center gap-1.5 rounded-md border border-border bg-muted px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/80 disabled:cursor-not-allowed disabled:opacity-40"
          @click="handleTestConnection"
        >
          <Loader2 v-if="testing" class="size-3 animate-spin" />
          <CheckCircle2 v-else class="size-3" />
          Test connection
        </button>
        <span v-if="testResult" class="flex items-center gap-1 text-xs" :class="testResult.success ? 'text-primary' : 'text-destructive'">
          <CheckCircle2 v-if="testResult.success" class="size-3.5" />
          <AlertCircle v-else class="size-3.5" />
          {{ testResult.success ? `Connected${testResult.username ? ` as ${testResult.username}` : ''}` : (testResult.error ?? 'Connection failed') }}
        </span>
      </div>

      <div class="flex items-center justify-between gap-4 border-t border-border pt-4">
        <div>
          <p class="text-sm">Enable scheduled sync</p>
          <p class="mt-0.5 text-xs text-muted-foreground">Pull updates from Audiobookshelf every 15 minutes.</p>
        </div>
        <ToggleSwitch v-model="form.enabled" :disabled="!isConfigured && !tokenInput.trim()" />
      </div>

      <div v-if="isConfigured" class="grid gap-2 rounded-md border border-border bg-muted/40 p-3 text-xs sm:grid-cols-2">
        <div>
          <span class="text-muted-foreground">Last sync</span>
          <p class="mt-0.5 text-foreground">{{ lastSyncedLabel }}</p>
        </div>
        <div>
          <span class="text-muted-foreground">Last error</span>
          <p data-testid="last-sync-error" class="mt-0.5" :class="settings?.lastSyncError ? 'text-destructive' : 'text-foreground'">
            {{ settings?.lastSyncError ?? 'None' }}
          </p>
        </div>
      </div>

      <div v-if="isConfigured" class="flex flex-col gap-2 sm:flex-row">
        <button
          type="button"
          :disabled="syncing || !settings?.effectiveEnabled"
          class="flex items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
          @click="handleSyncNow"
        >
          <Loader2 v-if="syncing && !isFullResync" class="size-3.5 animate-spin" />
          <RefreshCw v-else class="size-3.5" />
          Sync now
        </button>
        <button
          type="button"
          :disabled="syncing || !settings?.effectiveEnabled"
          class="flex items-center justify-center gap-1.5 rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted/80 disabled:cursor-not-allowed disabled:opacity-40"
          @click="handleFullResync"
        >
          <Loader2 v-if="isFullResync" class="size-3.5 animate-spin" />
          <RefreshCw v-else class="size-3.5" />
          Full resync
        </button>
      </div>
    </div>

    <p v-if="error && !testResult" class="flex items-center gap-1.5 text-xs text-destructive">
      <AlertCircle class="size-3.5 shrink-0" />
      {{ error }}
    </p>

    <div class="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
      <button
        v-if="isConfigured"
        type="button"
        :disabled="saving"
        class="flex items-center gap-1.5 text-xs text-destructive hover:underline disabled:cursor-not-allowed disabled:opacity-40"
        @click="handleDisconnect"
      >
        <Unlink class="size-3.5" />
        Disconnect
      </button>
      <div class="ml-auto">
        <button
          type="button"
          :disabled="saving || loading"
          class="flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
          @click="handleSave"
        >
          <Loader2 v-if="saving" class="size-3.5 animate-spin" />
          <Save v-else class="size-3.5" />
          Save connection
        </button>
      </div>
    </div>
  </section>
</template>

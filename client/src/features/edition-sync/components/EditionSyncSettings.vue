<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Info, Loader2, Repeat2, Save } from '@lucide/vue'
import type { EditionSyncBookSyncMode } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import { useEditionSyncSettings } from '../composables/useEditionSyncSettings'

const { t } = useI18n()
const { settings, saving, error, fetchSettings, saveSettings } = useEditionSyncSettings()

const loaded = ref(false)
const loadAttempted = ref(false)
const form = reactive({ enabled: false, bookSyncMode: 'all_eligible' as EditionSyncBookSyncMode })

const MODES: Array<{ id: EditionSyncBookSyncMode; key: string }> = [
  { id: 'all_eligible', key: 'allEligible' },
  { id: 'selected_only', key: 'selectedOnly' },
]

onMounted(async () => {
  await fetchSettings()
  loadAttempted.value = true
  if (settings.value) {
    form.enabled = settings.value.enabled
    form.bookSyncMode = settings.value.bookSyncMode
    loaded.value = true
  }
})

function selectMode(mode: EditionSyncBookSyncMode) {
  form.bookSyncMode = mode
}

async function handleSave() {
  if (!loaded.value) return
  const ok = await saveSettings({ enabled: form.enabled, bookSyncMode: form.bookSyncMode })
  if (ok) toast.success(t('editionSync.user.toast.saved'))
  else toast.error(error.value ?? t('editionSync.user.toast.saveFailed'))
}
</script>

<template>
  <div class="space-y-5 rounded-lg border border-border bg-card px-4 py-4 shadow-xs md:px-5 md:py-5">
    <div class="flex items-center gap-3">
      <Repeat2 class="size-5 shrink-0 text-primary" aria-hidden="true" />
      <div>
        <p class="text-sm font-medium">{{ t('editionSync.user.title') }}</p>
        <p class="mt-0.5 text-xs text-muted-foreground">{{ t('editionSync.user.description') }}</p>
      </div>
    </div>

    <div class="flex items-start gap-2 rounded-md border border-border/70 bg-muted/40 px-2.5 py-2">
      <Info class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <p class="text-xs leading-relaxed text-muted-foreground">{{ t('editionSync.user.info') }}</p>
    </div>

    <p v-if="loadAttempted && !loaded" class="text-xs text-destructive" role="alert">{{ error ?? t('editionSync.errors.settingsLoadFailed') }}</p>

    <div class="flex items-center justify-between gap-3">
      <div>
        <p class="text-sm">{{ t('editionSync.user.enable.title') }}</p>
        <p class="mt-0.5 text-xs text-muted-foreground">{{ t('editionSync.user.enable.description') }}</p>
      </div>
      <ToggleSwitch v-model="form.enabled" :disabled="!loaded" :aria-label="t('editionSync.user.enable.title')" />
    </div>

    <div class="space-y-2">
      <p class="text-sm">{{ t('editionSync.user.scope.title') }}</p>
      <div class="grid gap-2 sm:grid-cols-2">
        <button
          v-for="mode in MODES"
          :key="mode.id"
          type="button"
          :aria-pressed="form.bookSyncMode === mode.id"
          :disabled="!loaded || !form.enabled"
          class="rounded-md border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          :class="
            form.bookSyncMode === mode.id
              ? 'border-primary bg-primary/10 text-foreground'
              : 'border-border bg-background text-muted-foreground hover:bg-muted/50'
          "
          @click="selectMode(mode.id)"
        >
          <div class="text-sm font-medium">{{ t(`editionSync.user.scope.${mode.key}.label`) }}</div>
          <div class="mt-0.5 text-xs leading-relaxed">{{ t(`editionSync.user.scope.${mode.key}.description`) }}</div>
        </button>
      </div>
    </div>

    <div class="flex justify-end border-t border-border pt-4">
      <Button size="sm" type="button" :disabled="saving || !loaded" @click="handleSave">
        <Loader2 v-if="saving" class="size-3.5 animate-spin" />
        <Save v-else class="size-3.5" />
        {{ t('common.save') }}
      </Button>
    </div>
  </div>
</template>

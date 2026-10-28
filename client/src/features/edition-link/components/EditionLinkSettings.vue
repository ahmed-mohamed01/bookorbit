<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { Loader2, Save } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Permission } from '@bookorbit/types'
import SettingsPageHeader from '@/features/settings/SettingsPageHeader.vue'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import { Button } from '@/components/ui/button'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import { useAudiobookshelfSettings } from '@/features/audiobookshelf/composables/useAudiobookshelfSettings'
import { formatNumber } from '@/i18n/formatters'
import { filterCount } from '../composables/useEditionLinkMatches'
import { useEditionLinkScanSummary } from '../composables/useEditionLinkScanSummary'
import { useEditionLinkSettings } from '../composables/useEditionLinkSettings'
import AbsHistoryRebuildCard from './AbsHistoryRebuildCard.vue'
import PositionSyncSwitch from './PositionSyncSwitch.vue'
import WorkDiagram, { type AbsDirection } from './WorkDiagram.vue'

const props = withDefaults(defineProps<{ embedded?: boolean }>(), { embedded: false })

const { t } = useI18n()
const { hasPermission } = usePermissions()
const form = useEditionLinkSettings()
const abs = useAudiobookshelfSettings()
const scan = useEditionLinkScanSummary()

const draft = form.draft
const disabled = computed(() => !draft.value.enabled)
const showHistory = computed(() => hasPermission(Permission.AudiobookshelfSync))

const absDirection = computed<AbsDirection | null>(() => {
  const settings = abs.settings.value
  if (!settings) return null
  if (settings.syncPosition && settings.pushPosition) return 'twoWay'
  if (settings.syncPosition) return 'pull'
  if (settings.pushPosition) return 'push'
  return 'off'
})

const scanLine = computed(() => {
  const status = scan.status.value
  if (!status || status.state !== 'done') return t('settings.integrations.editionLinks.matching.noScan')
  return t('settings.integrations.editionLinks.matching.counts', {
    fix: formatNumber(filterCount(status, 'fix')),
    review: formatNumber(filterCount(status, 'review')),
    ready: formatNumber(filterCount(status, 'ready')),
  })
})

onMounted(() => {
  void form.fetchSettings()
  void scan.fetchStatus()
  if (!abs.settings.value && hasPermission(Permission.AudiobookshelfSync)) void abs.fetchSettings()
})

async function handleSave(): Promise<void> {
  const saved = await form.save()
  if (saved) toast.success(t('settings.integrations.editionLinks.saved'))
  else toast.error(t('settings.integrations.editionLinks.saveFailed'))
}
</script>

<template>
  <div class="space-y-6">
    <SettingsPageHeader
      v-if="!props.embedded"
      :title="t('settings.integrations.tabs.editionLinks')"
      :subtitle="t('settings.integrations.providerSubtitles.editionLinks')"
    />

    <div v-if="form.loading.value && !form.saved.value" class="flex items-center gap-2 text-sm text-muted-foreground" role="status">
      <Loader2 class="size-4 animate-spin" aria-hidden="true" />
      {{ t('common.loading') }}
    </div>

    <template v-else>
      <section class="space-y-4 rounded-lg border border-border bg-card px-4 py-4 shadow-xs md:px-5 md:py-5">
        <div class="flex items-center justify-between gap-4">
          <div>
            <p class="text-sm font-medium">{{ t('settings.integrations.editionLinks.master.label') }}</p>
            <p class="mt-0.5 text-xs text-muted-foreground">{{ t('settings.integrations.editionLinks.master.description') }}</p>
          </div>
          <ToggleSwitch v-model="draft.enabled" :aria-label="t('settings.integrations.editionLinks.master.label')" />
        </div>
        <WorkDiagram
          :enabled="draft.enabled"
          :share-reading-state="draft.shareReadingState"
          :position-sync="draft.positionSync"
          :abs-direction="absDirection"
        />
      </section>

      <section class="space-y-4 rounded-lg border border-border bg-card px-4 py-4 shadow-xs md:px-5 md:py-5">
        <p class="text-sm font-medium">{{ t('settings.integrations.editionLinks.sharing.title') }}</p>

        <div class="flex items-center justify-between gap-4">
          <div>
            <p class="text-sm">{{ t('settings.integrations.editionLinks.sharing.shareReadingState.label') }}</p>
            <p class="mt-0.5 text-xs text-muted-foreground">{{ t('settings.integrations.editionLinks.sharing.shareReadingState.description') }}</p>
          </div>
          <ToggleSwitch v-model="draft.shareReadingState" :disabled="disabled" />
        </div>

        <div class="flex items-center justify-between gap-4">
          <div>
            <p class="text-sm">{{ t('settings.integrations.editionLinks.sharing.sameType.label') }}</p>
            <p class="mt-0.5 text-xs text-muted-foreground">{{ t('settings.integrations.editionLinks.sharing.sameType.description') }}</p>
          </div>
          <ToggleSwitch v-model="draft.sameTypeAsOneWork" :disabled="disabled" />
        </div>

        <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div class="min-w-0">
            <p class="text-sm">{{ t('settings.integrations.editionLinks.sharing.positionSync.label') }}</p>
            <p class="mt-0.5 text-xs text-muted-foreground">{{ t('settings.integrations.editionLinks.sharing.positionSync.description') }}</p>
          </div>
          <PositionSyncSwitch v-model="draft.positionSync" :disabled="disabled" />
        </div>

        <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <div class="min-w-0">
            <p class="text-sm">{{ t('settings.integrations.editionLinks.sharing.primary.label') }}</p>
            <p class="mt-0.5 text-xs text-muted-foreground">{{ t('settings.integrations.editionLinks.sharing.primary.description') }}</p>
          </div>
          <RouterLink :to="{ name: 'settings-libraries' }" class="text-xs font-semibold text-primary hover:underline">
            {{ t('settings.integrations.editionLinks.sharing.primary.link') }}
          </RouterLink>
        </div>
      </section>

      <section class="space-y-4 rounded-lg border border-border bg-card px-4 py-4 shadow-xs md:px-5 md:py-5">
        <p class="text-sm font-medium">{{ t('settings.integrations.editionLinks.matching.title') }}</p>

        <div class="flex items-center justify-between gap-4">
          <div>
            <p class="text-sm">{{ t('settings.integrations.editionLinks.matching.autoLink.label') }}</p>
            <p class="mt-0.5 text-xs text-muted-foreground">{{ t('settings.integrations.editionLinks.matching.autoLink.description') }}</p>
          </div>
          <ToggleSwitch v-model="draft.autoLinkStrong" :disabled="disabled" />
        </div>

        <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-border bg-background px-3 py-2.5">
          <p class="text-xs text-muted-foreground" data-testid="scan-line">{{ scanLine }}</p>
          <RouterLink :to="{ name: 'tools-edition-links' }" class="text-xs font-semibold text-primary hover:underline">
            {{ t('settings.integrations.editionLinks.matching.openTool') }}
          </RouterLink>
        </div>
      </section>

      <AbsHistoryRebuildCard v-if="showHistory" />

      <p v-if="form.error.value && !form.saved.value" role="alert" class="text-sm text-destructive">
        {{ t('settings.integrations.editionLinks.loadFailed') }}
      </p>

      <div class="flex justify-end">
        <Button :disabled="form.saving.value || !form.dirty.value" @click="handleSave">
          <Loader2 v-if="form.saving.value" class="animate-spin" aria-hidden="true" />
          <Save v-else aria-hidden="true" />
          {{ t('settings.integrations.editionLinks.save') }}
        </Button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { AlertCircle, Loader2 } from '@lucide/vue'
import { Permission, type WebSerialKind } from '@bookorbit/types'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import { useLibraries } from '@/features/library/composables/useLibraries'
import SettingsPageHeader from '@/features/settings/SettingsPageHeader.vue'
import { useWebSerialSettings } from '../composables/useWebSerialSettings'
import WebSerialDefaults from './settings/WebSerialDefaults.vue'
import WebSerialEngineCard from './settings/WebSerialEngineCard.vue'
import WebSerialLookupCard from './settings/WebSerialLookupCard.vue'
import WebSerialExtensionsSheet from './settings/WebSerialExtensionsSheet.vue'
import WebSerialEngineSheet from './settings/WebSerialEngineSheet.vue'
import WebSerialMangaSources from './settings/WebSerialMangaSources.vue'
import WebSerialNovelIndexCard from './settings/WebSerialNovelIndexCard.vue'
import WebSerialNovelSources from './settings/WebSerialNovelSources.vue'
import WebSerialNovelSourcesSheet from './settings/WebSerialNovelSourcesSheet.vue'
import WebSerialSaveBar from './settings/WebSerialSaveBar.vue'
import { provideWebSerialSettings } from './settings/settingsContext'

const ENGINES: WebSerialKind[] = ['manga', 'novel']

const props = withDefaults(defineProps<{ embedded?: boolean }>(), { embedded: false })

const { t } = useI18n()
const { hasPermission } = usePermissions()
const { fetchLibraries } = useLibraries()
const state = useWebSerialSettings()
provideWebSerialSettings(state)
const { settings, loading, loadError, saving, testing, testResults, testError, draft, lookupHealth, testingLookup, lookupTestError } = state

const canManage = computed(() => hasPermission(Permission.ManageAppSettings))
const editingKind = ref<WebSerialKind | null>(null)
const managingSources = ref<WebSerialKind | null>(null)
const showNovelIndex = computed(() => settings.value?.novel.engine === 'lnreader' && Boolean(settings.value.novel.url))

onMounted(async () => {
  if (!canManage.value) return
  await Promise.all([state.load(), fetchLibraries()])
  void state.loadMangaSources()
  void state.loadNovelSources()
})

function urlOf(kind: WebSerialKind): string | null {
  return settings.value?.[kind].url ?? null
}

function handleTest(kind: WebSerialKind) {
  void state.test(kind)
}

function handleTestLookup() {
  void state.runLookupTest()
}

function handleLookupEnabled(value: boolean) {
  draft.lookupEnabled = value
}

function handleEdit(kind: WebSerialKind) {
  editingKind.value = kind
}

function handleManage(kind: WebSerialKind) {
  managingSources.value = kind
}

function handleCloseManage() {
  managingSources.value = null
}

async function handleSourcesChanged() {
  if (managingSources.value === 'manga') {
    await state.loadMangaSources()
    if (!state.mangaSourcesError.value) state.pruneSelectedSources()
  }
}

function handleCloseSheet() {
  editingKind.value = null
}

async function handleSave() {
  if (await state.savePage()) toast.success(t('webSerials.settings.saved'))
  else toast.error(state.saveError.value ?? t('webSerials.settings.saveFailed'))
}

function handleDiscard() {
  state.discardPage()
}
</script>

<template>
  <div class="space-y-6">
    <SettingsPageHeader v-if="!props.embedded" :title="t('webSerials.settings.title')" :subtitle="t('webSerials.settings.subtitle')" />

    <p v-if="!canManage" class="text-sm text-muted-foreground">{{ t('webSerials.settings.noPermission') }}</p>

    <template v-else>
      <div v-if="loading" class="settings-loading-state">
        <Loader2 class="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
        <span class="sr-only">{{ t('webSerials.settings.loading') }}</span>
      </div>

      <p v-else-if="loadError" role="alert" class="settings-error-state flex items-center gap-2">
        <AlertCircle class="size-4 shrink-0" aria-hidden="true" />
        {{ loadError }}
      </p>

      <template v-else-if="settings">
        <section aria-labelledby="web-serials-engines" class="space-y-2">
          <h3 id="web-serials-engines" class="settings-group-label">{{ t('webSerials.settings.engines') }}</h3>
          <div class="space-y-2">
            <WebSerialEngineCard
              v-for="kind in ENGINES"
              :key="kind"
              :kind="kind"
              :url="urlOf(kind)"
              :health="testResults[kind]"
              :testing="testing[kind]"
              :test-error="testError[kind]"
              :novel-engine="kind === 'novel' ? draft.novel.engine : undefined"
              @test="handleTest(kind)"
              @edit="handleEdit(kind)"
              @manage="handleManage(kind)"
            >
              <WebSerialMangaSources v-if="kind === 'manga'" />
              <WebSerialNovelSources v-else-if="draft.novel.engine === 'lncrawl'" />
            </WebSerialEngineCard>
            <WebSerialNovelIndexCard v-if="showNovelIndex" />
            <WebSerialLookupCard
              :enabled="draft.lookupEnabled"
              :health="lookupHealth"
              :testing="testingLookup"
              :test-error="lookupTestError"
              @test="handleTestLookup"
              @update:enabled="handleLookupEnabled"
            />
          </div>
        </section>

        <WebSerialDefaults />

        <WebSerialSaveBar
          v-if="state.hasPageChanges.value"
          :invalid="state.pageInvalid.value"
          :saving="saving"
          @save="handleSave"
          @discard="handleDiscard"
        />
      </template>
    </template>

    <WebSerialEngineSheet :kind="editingKind" @close="handleCloseSheet" />
    <WebSerialExtensionsSheet v-if="canManage" :open="managingSources === 'manga'" @close="handleCloseManage" @changed="handleSourcesChanged" />
    <WebSerialNovelSourcesSheet v-if="canManage" :open="managingSources === 'novel'" @close="handleCloseManage" @changed="handleSourcesChanged" />
  </div>
</template>

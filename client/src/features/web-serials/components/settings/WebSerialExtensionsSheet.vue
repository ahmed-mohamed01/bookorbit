<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { X } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { useWebSerialExtensions } from '../../composables/useWebSerialExtensions'
import { provideWebSerialExtensions } from './extensionsContext'
import WebSerialSourcesDisclaimer from '../WebSerialSourcesDisclaimer.vue'
import WebSerialExtensionRepos from './WebSerialExtensionRepos.vue'
import WebSerialExtensionsAvailable from './WebSerialExtensionsAvailable.vue'
import WebSerialExtensionsInstalled from './WebSerialExtensionsInstalled.vue'

type Tab = 'installed' | 'available' | 'repositories'

const TABS: Tab[] = ['installed', 'available', 'repositories']

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; changed: [] }>()

const { t } = useI18n()
const state = useWebSerialExtensions(() => emit('changed'))
provideWebSerialExtensions(state)

const tab = ref<Tab>('installed')
const confirmName = computed(() => state.pendingUninstall.value?.name ?? '')

watch(
  () => props.open,
  (open) => {
    if (!open) return
    tab.value = 'installed'
    void state.open()
  },
  { immediate: true },
)

function handleOpenChange(open: boolean) {
  if (!open) emit('close')
}

function handleClose() {
  emit('close')
}

function selectTab(next: Tab) {
  tab.value = next
}

function handleGoToRepositories() {
  tab.value = 'repositories'
}

async function handleConfirmUninstall() {
  await state.confirmUninstall()
}

function handleCancelUninstall() {
  state.cancelUninstall()
}
</script>

<template>
  <Sheet :open="open" @update:open="handleOpenChange">
    <SheetContent side="right" hide-close class="w-full gap-0 p-0 sm:max-w-2xl">
      <div class="flex min-h-0 flex-1 flex-col">
        <header class="flex items-start justify-between gap-3 border-b border-border px-4 py-3.5 md:px-5">
          <div class="min-w-0">
            <div class="flex items-center gap-1.5">
              <SheetTitle class="settings-label">{{ t('webSerials.settings.extensions.title') }}</SheetTitle>
              <WebSerialSourcesDisclaimer />
            </div>
            <SheetDescription class="mt-1 text-xs text-muted-foreground">{{ t('webSerials.settings.extensions.description') }}</SheetDescription>
          </div>
          <Button size="sm" variant="outline" class="shrink-0" @click="handleClose">
            <X :size="15" aria-hidden="true" />
            <span class="sr-only">{{ t('common.close') }}</span>
          </Button>
        </header>

        <div role="tablist" :aria-label="t('webSerials.settings.extensions.title')" class="flex gap-4 border-b border-border px-4 md:px-5">
          <button
            v-for="id in TABS"
            :id="`web-serials-ext-tab-${id}`"
            :key="id"
            type="button"
            role="tab"
            :aria-selected="tab === id"
            :aria-controls="`web-serials-ext-panel-${id}`"
            class="-mb-px border-b-2 px-0.5 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            :class="tab === id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'"
            @click="selectTab(id)"
          >
            {{ t(`webSerials.settings.extensions.tabs.${id}`) }}
          </button>
        </div>

        <div
          :id="`web-serials-ext-panel-${tab}`"
          role="tabpanel"
          :aria-labelledby="`web-serials-ext-tab-${tab}`"
          class="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-5"
        >
          <p v-if="state.actionError.value" role="alert" class="mb-3 text-xs text-destructive">{{ state.actionError.value }}</p>
          <WebSerialExtensionsInstalled v-if="tab === 'installed'" />
          <WebSerialExtensionsAvailable v-else-if="tab === 'available'" @go-to-repositories="handleGoToRepositories" />
          <WebSerialExtensionRepos v-else />
        </div>
      </div>
    </SheetContent>
  </Sheet>

  <ConfirmDialog
    :open="state.pendingUninstall.value !== null"
    :title="t('webSerials.settings.extensions.uninstallTitle', { name: confirmName })"
    :description="t('webSerials.settings.extensions.uninstallDescription')"
    :confirm-label="t('webSerials.settings.extensions.uninstall')"
    :busy="state.pendingUninstall.value ? Boolean(state.busy[state.pendingUninstall.value.pkgName]) : false"
    @confirm="handleConfirmUninstall"
    @cancel="handleCancelUninstall"
  />
</template>

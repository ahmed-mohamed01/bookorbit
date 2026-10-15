<script setup lang="ts">
import { watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, Loader2, Search } from '@lucide/vue'
import EmptyState from '@/components/EmptyState.vue'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import { formatNumber } from '@/i18n/formatters'
import { useWebSerialNovelProviders } from '../composables/useWebSerialNovelProviders'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ 'update:open': [value: boolean] }>()

const { t } = useI18n()
const state = useWebSerialNovelProviders()
const { providers, loading, error, search, unavailable, linkSitesTotal, linkQuery, linkOpen, filteredLinkSites } = state

watch(
  () => props.open,
  (open) => {
    if (open && !providers.value) void state.load()
  },
  { immediate: true },
)

function handleOpenChange(value: boolean) {
  emit('update:open', value)
}

function handleRetry() {
  void state.load()
}

function handleToggle(domain: string, enabled: boolean) {
  void state.toggle(domain, enabled)
}

function handleLinkQuery(event: Event) {
  state.setLinkQuery((event.target as HTMLInputElement).value)
}

function handleToggleLinks() {
  state.toggleLinkOpen()
}
</script>

<template>
  <Sheet :open="props.open" @update:open="handleOpenChange">
    <SheetContent side="right" class="w-full gap-0 p-0 sm:max-w-md">
      <header class="shrink-0 border-b border-border p-5 pt-10">
        <SheetTitle class="text-lg font-bold text-foreground">{{ t('webSerials.novelProviders.title') }}</SheetTitle>
        <SheetDescription class="mt-0.5 text-sm text-muted-foreground">{{ t('webSerials.novelProviders.description') }}</SheetDescription>
      </header>

      <div class="min-h-0 flex-1 overflow-y-auto p-5">
        <p v-if="loading && !providers" class="flex items-center gap-2 text-sm text-muted-foreground" aria-busy="true">
          <Loader2 class="size-4 animate-spin" aria-hidden="true" />
          {{ t('webSerials.novelProviders.loading') }}
        </p>

        <EmptyState v-else-if="error && !providers" icon="TriangleAlert" :title="t('webSerials.novelProviders.loadErrorTitle')" :hint="error">
          <template #actions>
            <Button variant="outline" size="sm" @click="handleRetry">{{ t('common.retry') }}</Button>
          </template>
        </EmptyState>

        <div v-else-if="providers" class="space-y-6">
          <section aria-labelledby="web-serials-providers-search">
            <h3 id="web-serials-providers-search" class="text-[10.5px] font-semibold tracking-wider text-muted-foreground uppercase">
              {{ t('webSerials.novelProviders.searchTitle') }}
            </h3>
            <p class="mt-1 text-xs text-muted-foreground">{{ t('webSerials.novelProviders.searchHint') }}</p>
            <p v-if="search.length === 0" class="mt-3 text-sm text-muted-foreground">{{ t('webSerials.novelProviders.searchEmpty') }}</p>
            <ul v-else class="mt-3 divide-y divide-border rounded-lg border border-border bg-card">
              <li v-for="provider in search" :key="provider.domain" class="flex items-center gap-3 px-3 py-2.5">
                <div class="min-w-0 flex-1">
                  <p class="truncate text-sm font-medium text-foreground">{{ provider.name }}</p>
                  <p v-if="provider.name !== provider.domain" class="truncate text-xs text-muted-foreground">{{ provider.domain }}</p>
                </div>
                <ToggleSwitch
                  :model-value="provider.enabled"
                  :aria-label="t('webSerials.novelProviders.toggle', { name: provider.name })"
                  @update:model-value="handleToggle(provider.domain, $event)"
                />
              </li>
            </ul>
          </section>

          <section aria-labelledby="web-serials-providers-links">
            <h3 id="web-serials-providers-links" class="text-[10.5px] font-semibold tracking-wider text-muted-foreground uppercase">
              <button
                type="button"
                class="flex w-full items-center gap-2 text-start uppercase focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                aria-controls="web-serials-providers-links-body"
                :aria-expanded="linkOpen"
                @click="handleToggleLinks"
              >
                <span>{{ t('webSerials.novelProviders.linksTitle') }}</span>
                <span v-if="!unavailable" class="text-xs font-normal tracking-normal normal-case">{{ formatNumber(linkSitesTotal) }}</span>
                <ChevronDown
                  class="ms-auto size-4 transition-transform motion-reduce:transition-none"
                  :class="linkOpen ? 'rotate-180' : ''"
                  aria-hidden="true"
                />
              </button>
            </h3>
            <p class="mt-1 text-xs text-muted-foreground">{{ t('webSerials.novelProviders.linksAdvice') }}</p>

            <div v-if="linkOpen" id="web-serials-providers-links-body" class="mt-3">
              <p v-if="unavailable" class="text-sm text-muted-foreground">{{ t('webSerials.novelProviders.linksUnavailable') }}</p>
              <template v-else>
                <div class="relative mb-2.5">
                  <Search class="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                  <label for="web-serials-providers-filter" class="sr-only">{{ t('webSerials.novelProviders.filterLabel') }}</label>
                  <input
                    id="web-serials-providers-filter"
                    type="search"
                    autocomplete="off"
                    :value="linkQuery"
                    :placeholder="t('webSerials.novelProviders.filterPlaceholder', { count: formatNumber(linkSitesTotal) })"
                    class="settings-control ps-8"
                    @input="handleLinkQuery"
                  />
                </div>
                <p v-if="filteredLinkSites.length === 0" class="text-sm text-muted-foreground">{{ t('webSerials.novelProviders.filterEmpty') }}</p>
                <ul v-else class="max-h-80 divide-y divide-border overflow-y-auto rounded-lg border border-border bg-card">
                  <li v-for="site in filteredLinkSites" :key="site.domain" class="px-3 py-2">
                    <p class="truncate text-sm text-foreground">{{ site.name }}</p>
                    <p v-if="site.name !== site.domain" class="truncate text-xs text-muted-foreground">{{ site.domain }}</p>
                  </li>
                </ul>
              </template>
            </div>
          </section>
        </div>
      </div>
    </SheetContent>
  </Sheet>
</template>

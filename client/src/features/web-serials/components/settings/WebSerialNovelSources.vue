<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Search } from '@lucide/vue'
import { NOVEL_CHIPS_COLLAPSED, orderedDomains, searchableDomains, toggleDomain } from './settingsLib'
import { useWebSerialSettingsContext } from './settingsContext'
import WebSerialSourcesDisclaimer from '../WebSerialSourcesDisclaimer.vue'

const { t } = useI18n()
const state = useWebSerialSettingsContext()
const { draft, settings, novelSources, novelSourcesLoading, novelSourcesError } = state

const query = ref('')
const showAll = ref(false)

const domains = computed(() => searchableDomains(novelSources.value))
const ordered = computed(() => orderedDomains(domains.value, settings.value?.novel.searchDomains ?? [], query.value))
const visible = computed(() => (showAll.value ? ordered.value : ordered.value.slice(0, NOVEL_CHIPS_COLLAPSED)))
const hiddenCount = computed(() => ordered.value.length - visible.value.length)
const selectedCount = computed(() => draft.novel.searchDomains.filter((domain) => domains.value.includes(domain)).length)

function isSelected(domain: string): boolean {
  return draft.novel.searchDomains.includes(domain)
}

function handleToggle(domain: string) {
  draft.novel.searchDomains = toggleDomain(draft.novel.searchDomains, domain)
}

function handleShowAll() {
  showAll.value = true
}
</script>

<template>
  <div>
    <div class="mb-2.5 flex items-center gap-2.5">
      <div class="flex items-center gap-1.5">
        <h4 id="web-serials-novel-sources" class="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
          {{ t('webSerials.settings.sources.novelTitle') }}
        </h4>
        <WebSerialSourcesDisclaimer />
      </div>
      <span v-if="domains.length" class="ms-auto text-xs text-muted-foreground">
        {{ t('webSerials.settings.sources.novelMeta', { selected: selectedCount, total: domains.length }) }}
      </span>
    </div>

    <p v-if="novelSourcesLoading" class="text-xs text-muted-foreground">{{ t('webSerials.settings.sources.loading') }}</p>
    <p v-else-if="novelSourcesError" role="alert" class="text-xs text-destructive">{{ novelSourcesError }}</p>
    <p v-else-if="domains.length === 0" class="text-xs text-muted-foreground">{{ t('webSerials.settings.sources.novelEmpty') }}</p>

    <template v-else>
      <div class="relative mb-2.5">
        <Search class="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <label for="web-serials-novel-filter" class="sr-only">{{ t('webSerials.settings.sources.novelFilterLabel') }}</label>
        <input
          id="web-serials-novel-filter"
          v-model="query"
          type="search"
          autocomplete="off"
          :placeholder="t('webSerials.settings.sources.novelFilter', { count: domains.length })"
          class="settings-control ps-8"
        />
      </div>

      <ul class="flex flex-wrap gap-1.5" aria-labelledby="web-serials-novel-sources">
        <li v-for="domain in visible" :key="domain">
          <button
            type="button"
            class="rounded-md border px-2 py-0.5 text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            :class="
              isSelected(domain)
                ? 'border-transparent bg-primary/10 text-primary'
                : 'border-border bg-muted text-muted-foreground hover:text-foreground'
            "
            :aria-pressed="isSelected(domain)"
            @click="handleToggle(domain)"
          >
            {{ domain }}
          </button>
        </li>
      </ul>
      <p v-if="ordered.length === 0" class="text-xs text-muted-foreground">{{ t('webSerials.settings.sources.novelNoMatch') }}</p>
      <button
        v-if="hiddenCount > 0"
        type="button"
        class="mt-2 text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        @click="handleShowAll"
      >
        {{ t('webSerials.settings.sources.showAll', { count: ordered.length }) }}
      </button>
      <p class="settings-hint mt-2.5">{{ t('webSerials.settings.sources.novelHint') }}</p>
    </template>
  </div>
</template>

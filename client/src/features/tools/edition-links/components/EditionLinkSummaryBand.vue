<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { EditionLinkScanStatus } from '@bookorbit/types'

import { formatNumber } from '@/i18n/formatters'
import { filterCount, type EditionLinkFilter } from '@/features/edition-link/composables/useEditionLinkMatches'

const props = defineProps<{
  scan: EditionLinkScanStatus
  activeFilter: EditionLinkFilter | undefined
  dismissedOpen: boolean
}>()

const emit = defineEmits<{ filter: [filter: EditionLinkFilter | undefined]; toggleDismissed: [] }>()

const { t } = useI18n()

const FILTERS: { key: EditionLinkFilter; color: string }[] = [
  { key: 'fix', color: 'var(--destructive)' },
  { key: 'review', color: 'var(--pill-warning)' },
  { key: 'ready', color: 'var(--pill-success)' },
  { key: 'linked', color: 'var(--pill-info)' },
]

function handleFilter(event: MouseEvent): void {
  const key = (event.currentTarget as HTMLElement).dataset.filter as EditionLinkFilter
  emit('filter', props.activeFilter === key ? undefined : key)
}

function handleClear(): void {
  emit('filter', undefined)
}

function handleDismissed(): void {
  emit('toggleDismissed')
}
</script>

<template>
  <div class="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2">
    <div class="flex flex-wrap items-center gap-1.5" role="group" :aria-label="t('tools.editionLinks.filter')">
      <button
        v-if="activeFilter"
        type="button"
        class="inline-flex h-[26px] items-center rounded-full px-2.5 text-[12px] font-semibold text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        @click="handleClear"
      >
        {{ t('tools.editionLinks.allMatches') }}
      </button>
      <button
        v-for="filter in FILTERS"
        :key="filter.key"
        type="button"
        :data-filter="filter.key"
        class="inline-flex h-[26px] items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        :class="
          activeFilter === filter.key
            ? 'border-primary/40 bg-primary/14 text-foreground'
            : 'border-transparent text-muted-foreground hover:bg-accent hover:text-foreground'
        "
        :aria-pressed="activeFilter === filter.key"
        @click="handleFilter"
      >
        <span class="size-1.5 rounded-full" :style="{ backgroundColor: filter.color }" aria-hidden="true" />
        {{ t(`tools.editionLinks.filters.${filter.key}`) }}
        <span class="min-w-[18px] rounded-full bg-muted px-1.5 text-center text-[11px] font-bold tabular-nums text-muted-foreground">
          {{ formatNumber(filterCount(scan, filter.key)) }}
        </span>
      </button>
      <button
        type="button"
        class="inline-flex h-[26px] items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        :class="
          dismissedOpen
            ? 'border-primary/40 bg-primary/14 text-foreground'
            : 'border-transparent text-muted-foreground hover:bg-accent hover:text-foreground'
        "
        :aria-pressed="dismissedOpen"
        @click="handleDismissed"
      >
        {{ t('tools.editionLinks.filters.dismissed') }}
        <span class="min-w-[18px] rounded-full bg-muted px-1.5 text-center text-[11px] font-bold tabular-nums text-muted-foreground">
          {{ formatNumber(scan.dismissed) }}
        </span>
      </button>
    </div>
    <p v-if="scan.autoLinked > 0" class="text-[12px] text-muted-foreground sm:ms-auto">
      {{ t('tools.editionLinks.autoLinked', { count: formatNumber(scan.autoLinked) }, scan.autoLinked) }}
    </p>
  </div>
</template>

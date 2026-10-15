<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, ChevronRight } from '@lucide/vue'
import type { WebSerialCatalogEntry } from '@bookorbit/types'
import type { WebSerialResultDensity } from '../lib/serialPresentation'
import WebSerialCover from './WebSerialCover.vue'

const props = defineProps<{ entry: WebSerialCatalogEntry; density?: WebSerialResultDensity }>()
const emit = defineEmits<{ open: [entry: WebSerialCatalogEntry] }>()

const { t } = useI18n()

const compact = computed(() => props.density === 'compact')
const authorLine = computed(() => props.entry.authors.join(', '))
const metaLine = computed(() => {
  const parts: string[] = []
  if (props.entry.year !== null) parts.push(String(props.entry.year))
  if (props.entry.status !== 'unknown') parts.push(t(`webSerials.seriesStatus.${props.entry.status}`))
  return parts.join(' · ')
})

function handleOpen() {
  emit('open', props.entry)
}
</script>

<template>
  <li>
    <button
      v-if="compact"
      type="button"
      data-density="compact"
      class="group flex w-full items-center gap-2 rounded-md border border-border bg-card px-2 py-1 text-start transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none"
      @click="handleOpen"
    >
      <WebSerialCover :src="entry.coverUrl" :title="entry.title" class="hidden h-9 w-6 rounded-[2px] shadow-none sm:block" />
      <p class="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">{{ entry.title }}</p>
      <span class="shrink-0 rounded-full border border-border bg-muted px-1.5 text-[10px] font-medium text-foreground">
        {{ t(`webSerials.kind.${entry.kind}`) }}
      </span>
      <span v-if="metaLine" class="hidden shrink-0 text-[11px] whitespace-nowrap text-muted-foreground sm:inline">{{ metaLine }}</span>
      <span
        v-if="entry.inLibrary"
        class="inline-flex shrink-0 items-center gap-1 rounded-full border border-success/40 bg-success/10 px-1.5 text-[10px] font-medium text-success"
        :aria-label="t('webSerials.discover.series.inLibraryLabel')"
      >
        <Check :size="10" :stroke-width="2.5" aria-hidden="true" />
        {{ t('webSerials.discover.series.inLibrary') }}
      </span>
      <ChevronRight class="size-3.5 shrink-0 text-muted-foreground rtl:rotate-180" aria-hidden="true" />
    </button>
    <button
      v-else
      type="button"
      class="group flex w-full items-center gap-3 rounded-lg border border-border bg-card p-3 text-start transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none"
      @click="handleOpen"
    >
      <WebSerialCover :src="entry.coverUrl" :title="entry.title" class="h-[74px] w-[50px]" />
      <div class="min-w-0 flex-1">
        <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <p class="truncate text-[15px] font-semibold text-foreground">{{ entry.title }}</p>
          <span class="shrink-0 rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-foreground">
            {{ t(`webSerials.kind.${entry.kind}`) }}
          </span>
          <span
            v-if="entry.inLibrary"
            class="inline-flex shrink-0 items-center gap-1 rounded-full border border-success/40 bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success"
            :aria-label="t('webSerials.discover.series.inLibraryLabel')"
          >
            <Check :size="11" :stroke-width="2.5" aria-hidden="true" />
            {{ t('webSerials.discover.series.inLibrary') }}
          </span>
        </div>
        <p v-if="authorLine" class="truncate text-xs text-muted-foreground">{{ authorLine }}</p>
        <p v-if="metaLine" class="mt-1 truncate text-xs text-muted-foreground">{{ metaLine }}</p>
      </div>
      <span
        class="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground group-hover:text-foreground"
      >
        {{ t('webSerials.discover.open') }}
        <ChevronRight class="size-3.5 rtl:rotate-180" aria-hidden="true" />
      </span>
    </button>
  </li>
</template>

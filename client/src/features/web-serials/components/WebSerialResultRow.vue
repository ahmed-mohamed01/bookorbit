<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronRight, Loader2 } from '@lucide/vue'
import type { WebSerialSearchHit } from '@bookorbit/types'
import type { WebSerialResultDensity } from '../lib/serialPresentation'
import WebSerialCover from './WebSerialCover.vue'

const props = defineProps<{ hit: WebSerialSearchHit; opening: boolean; disabled: boolean; density?: WebSerialResultDensity }>()
const emit = defineEmits<{ open: [hit: WebSerialSearchHit] }>()

const { t } = useI18n()

const compact = computed(() => props.density === 'compact')

const metaParts = computed(() => {
  const parts = [props.hit.sourceName]
  if (props.hit.chapterCount !== null) parts.push(t('webSerials.chapters', { count: props.hit.chapterCount }))
  if (props.hit.status !== 'unknown') parts.push(t(`webSerials.seriesStatus.${props.hit.status}`))
  return parts
})

const compactMeta = computed(() => {
  const parts: string[] = []
  if (props.hit.chapterCount !== null) parts.push(t('webSerials.chapters', { count: props.hit.chapterCount }))
  if (props.hit.status !== 'unknown') parts.push(t(`webSerials.seriesStatus.${props.hit.status}`))
  return parts.join(' · ')
})

function handleOpen() {
  emit('open', props.hit)
}
</script>

<template>
  <li>
    <button
      v-if="compact"
      type="button"
      data-density="compact"
      class="group flex w-full items-center gap-2 rounded-md border border-border bg-card px-2 py-1 text-start transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none"
      :disabled="disabled"
      :aria-busy="opening"
      @click="handleOpen"
    >
      <WebSerialCover :src="hit.coverUrl" :title="hit.title" class="hidden h-9 w-6 rounded-[2px] shadow-none sm:block" />
      <p class="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">{{ hit.title }}</p>
      <span class="shrink-0 rounded-full border border-border bg-muted px-1.5 text-[10px] font-medium text-foreground">
        {{ t(`webSerials.kind.${hit.kind}`) }}
      </span>
      <span
        v-if="hit.mtl"
        class="shrink-0 rounded-full border border-border bg-muted px-1.5 text-[10px] font-medium text-muted-foreground"
        :title="t('webSerials.results.mtlTitle')"
        data-testid="mtl-chip"
      >
        {{ t('webSerials.results.mtl') }}
      </span>
      <span class="max-w-[7rem] shrink-0 truncate text-[11px] text-muted-foreground sm:max-w-[10rem]">{{ hit.sourceName }}</span>
      <span v-if="compactMeta" class="hidden shrink-0 text-[11px] whitespace-nowrap text-muted-foreground sm:inline">{{ compactMeta }}</span>
      <Loader2 v-if="opening" class="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
      <ChevronRight v-else class="size-3.5 shrink-0 text-muted-foreground rtl:rotate-180" aria-hidden="true" />
      <span v-if="opening" class="sr-only">{{ t('webSerials.results.opening') }}</span>
    </button>
    <button
      v-else
      type="button"
      class="group flex w-full items-center gap-3 rounded-lg border border-border bg-card p-3 text-start transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none"
      :disabled="disabled"
      :aria-busy="opening"
      @click="handleOpen"
    >
      <WebSerialCover :src="hit.coverUrl" :title="hit.title" class="h-[74px] w-[50px]" />
      <div class="min-w-0 flex-1">
        <div class="flex min-w-0 items-center gap-2">
          <p class="truncate text-[15px] font-semibold text-foreground">{{ hit.title }}</p>
          <span class="shrink-0 rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-foreground">
            {{ t(`webSerials.kind.${hit.kind}`) }}
          </span>
          <span
            v-if="hit.mtl"
            class="shrink-0 rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
            :title="t('webSerials.results.mtlTitle')"
            data-testid="mtl-chip"
          >
            {{ t('webSerials.results.mtl') }}
          </span>
        </div>
        <p v-if="hit.author" class="truncate text-xs text-muted-foreground">{{ hit.author }}</p>
        <p class="mt-1 truncate text-xs text-muted-foreground">{{ metaParts.join(' · ') }}</p>
      </div>
      <Loader2 v-if="opening" class="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
      <span
        v-else
        class="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground group-hover:text-foreground"
      >
        {{ t('webSerials.discover.open') }}
        <ChevronRight class="size-3.5 rtl:rotate-180" aria-hidden="true" />
      </span>
      <span v-if="opening" class="sr-only">{{ t('webSerials.results.opening') }}</span>
    </button>
  </li>
</template>

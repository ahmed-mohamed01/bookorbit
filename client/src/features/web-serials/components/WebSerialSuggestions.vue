<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { BadgeCheck } from '@lucide/vue'
import type { WebSerialSuggestion } from '@bookorbit/types'
import { suggestionOptionId, suggestionPills } from '../lib/serialSuggest'
import WebSerialCover from './WebSerialCover.vue'

const props = defineProps<{
  id: string
  suggestions: WebSerialSuggestion[]
  open: boolean
  highlighted: number
}>()

const emit = defineEmits<{ highlight: [index: number]; choose: [suggestion: WebSerialSuggestion] }>()

const { t } = useI18n()

// Keeps focus in the search box, so its blur does not close the list before the click lands.
function handleMousedown(event: MouseEvent) {
  event.preventDefault()
}

function handleHover(index: number) {
  emit('highlight', index)
}

function handleChoose(suggestion: WebSerialSuggestion) {
  emit('choose', suggestion)
}

function optionKey(suggestion: WebSerialSuggestion): string {
  return suggestion.matchId ? `m:${suggestion.matchId}` : `t:${suggestion.entries[0]?.seriesKey ?? suggestion.title}`
}
</script>

<template>
  <ul
    v-show="props.open"
    :id="props.id"
    role="listbox"
    :aria-label="t('webSerials.suggest.label')"
    class="absolute inset-x-0 top-full z-30 mt-1 max-h-[min(24rem,60vh)] overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
    data-testid="suggestions"
    @mousedown="handleMousedown"
  >
    <li
      v-for="(suggestion, index) in props.suggestions"
      :id="suggestionOptionId(index)"
      :key="optionKey(suggestion)"
      role="option"
      :aria-selected="index === props.highlighted"
      class="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5"
      :class="index === props.highlighted ? 'bg-accent text-accent-foreground' : ''"
      data-testid="suggestion"
      @mouseenter="handleHover(index)"
      @click="handleChoose(suggestion)"
    >
      <WebSerialCover :src="suggestion.cover" :title="suggestion.title" class="h-11 w-8 shadow-none" />
      <div class="min-w-0 flex-1">
        <p class="flex items-center gap-1.5 truncate text-sm font-medium">
          <span class="truncate">{{ suggestion.title }}</span>
          <BadgeCheck v-if="suggestion.matchId" :size="14" class="shrink-0 text-primary" :aria-label="t('webSerials.suggest.matched')" />
        </p>
        <p class="mt-0.5 flex flex-wrap items-center gap-1" data-testid="suggestion-sources">
          <span
            v-for="name in suggestionPills(suggestion).names"
            :key="name"
            class="rounded-full border border-border bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground"
            data-testid="source-pill"
          >
            {{ name }}
          </span>
          <span
            v-if="suggestionPills(suggestion).more > 0"
            class="rounded-full border border-border bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground tabular-nums"
            data-testid="source-pill-more"
          >
            +{{ suggestionPills(suggestion).more }}
          </span>
          <span
            v-if="suggestion.mtlOnly"
            class="rounded-full border border-border bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground"
            :title="t('webSerials.results.mtlTitle')"
            data-testid="mtl-chip"
          >
            {{ t('webSerials.results.mtl') }}
          </span>
        </p>
      </div>
    </li>
  </ul>
</template>

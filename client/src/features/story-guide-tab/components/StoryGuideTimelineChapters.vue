<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { entityKindColor, entityKindIcon } from '../lib/entity-kind-icon'
import { entityGroup, type EntityGroup, type StoryGuideView } from '../lib/story-guide-view'
import StoryGuideHereMark from './StoryGuideHereMark.vue'
import StoryGuideHighlight from './StoryGuideHighlight.vue'

type Chapter = Pick<StoryGuideView['chapters'][number], 's' | 'title' | 'start' | 'current' | 'notes'>

const props = defineProps<{
  chapters: readonly Chapter[]
  kinds: ReadonlySet<EntityGroup>
  query?: string
  here?: 'first' | 'last' | null
  hereLabel?: string
}>()
const emit = defineEmits<{ open: [key: string] }>()
const { t } = useI18n()

function chips(entities: Iterable<{ key: string; name: string; kind: string }>) {
  return [...entities].filter((entity) => props.kinds.has(entityGroup(entity.kind)))
}
</script>

<template>
  <div class="relative grid grid-cols-[minmax(0,1fr)] gap-4.5 ps-5.5" data-testid="story-guide-timeline">
    <span class="absolute inset-y-1.5 start-1.25 w-px bg-border" aria-hidden="true" />
    <StoryGuideHereMark v-if="here === 'first' && hereLabel" :label="hereLabel" data-testid="story-guide-cutmark" />
    <div v-for="chapter in chapters" :key="chapter.s" class="relative">
      <span
        class="absolute -start-5.25 top-1.25 size-2.25 rounded-full border-[1.5px]"
        :class="chapter.current ? 'border-info bg-info' : 'border-muted-foreground bg-card'"
        aria-hidden="true"
      />
      <h3 class="flex flex-wrap items-baseline gap-x-2 text-sm font-semibold">
        {{ chapter.title }}
        <span class="text-xs font-normal tabular-nums text-muted-foreground">{{ Math.round(chapter.start) }}%</span>
        <span v-if="chapter.current" class="rounded-full bg-info/10 px-1.5 text-xs font-normal text-info">{{
          t('book.detail.storyGuideTab.reading')
        }}</span>
      </h3>
      <ul class="mt-1.5 grid gap-1.5 [content-visibility:auto] [contain-intrinsic-size:auto_4.5rem]">
        <li v-for="note in chapter.notes" :key="`${note.s}:${note.text}`" class="max-w-[70ch] text-[13.5px]/[1.55]">
          <StoryGuideHighlight :text="note.text" :query="query" />
          <span class="ms-1.5 inline-flex flex-wrap gap-1 align-[1px]">
            <button
              v-for="person in chips(note.entities)"
              :key="person.key"
              type="button"
              class="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-xs hover:bg-accent"
              @click="emit('open', person.key)"
            >
              <component :is="entityKindIcon(person.kind)" class="size-3 shrink-0" :class="entityKindColor(person.kind)" aria-hidden="true" />
              {{ person.name }}
            </button>
          </span>
        </li>
      </ul>
    </div>
    <StoryGuideHereMark v-if="here === 'last' && hereLabel" :label="hereLabel" data-testid="story-guide-cutmark" />
  </div>
</template>

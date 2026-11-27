<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { entityKindColor, entityKindIcon } from '../lib/entity-kind-icon'
import type { EntityView } from '../lib/story-guide-view'
import StoryGuideHighlight from './StoryGuideHighlight.vue'

const props = defineProps<{ entity: EntityView; since: string; query?: string }>()
const emit = defineEmits<{ open: [key: string] }>()
const { t } = useI18n()

function open() {
  emit('open', props.entity.key)
}
</script>

<template>
  <button
    type="button"
    class="flex min-w-0 flex-col gap-1.5 rounded-xl border border-border bg-card px-3.5 py-3 text-start hover:bg-muted/60 focus-visible:outline-ring"
    @click="open"
  >
    <span class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <component :is="entityKindIcon(entity.kind)" class="size-3.5 shrink-0" :class="entityKindColor(entity.kind)" aria-hidden="true" />
      <span class="min-w-0 font-semibold break-words"><StoryGuideHighlight :text="entity.name" :query="query" /></span>
      <span class="text-xs text-muted-foreground">{{
        t(`book.detail.storyGuideTab.kinds.${entity.kind}`, t('book.detail.storyGuideTab.kinds.term'))
      }}</span>
      <span class="ms-auto flex shrink-0 items-end gap-0.5" :aria-label="t(`book.detail.storyGuideTab.importance.${entity.importance}`)" role="img">
        <span
          v-for="bar in 3"
          :key="bar"
          class="w-0.5 rounded-full"
          :class="bar <= 4 - entity.importance ? 'bg-foreground/70' : 'bg-border'"
          :style="{ height: `${4 + 3 * bar}px` }"
        />
      </span>
    </span>
    <span v-if="entity.aliases.length" class="text-xs break-words text-muted-foreground"
      >{{ t('book.detail.storyGuideTab.alsoKnownAs') }} <StoryGuideHighlight :text="entity.aliases.map(({ name }) => name).join(', ')" :query="query"
    /></span>
    <span class="line-clamp-3 text-sm break-words" :class="{ 'text-muted-foreground': !entity.profiles.length }">
      {{ entity.profiles[0]?.text ?? t('book.detail.storyGuideTab.noProfile') }}
    </span>
    <span class="mt-auto pt-1 text-xs tabular-nums text-muted-foreground">{{ t('book.detail.storyGuideTab.since', { chapter: since }) }}</span>
  </button>
</template>

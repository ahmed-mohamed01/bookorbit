<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { matchesName } from '../lib/story-guide-search'
import type { EntityGroup, StoryGuideView } from '../lib/story-guide-view'
import StoryGuideEntityCard from './StoryGuideEntityCard.vue'

const props = defineProps<{ view: StoryGuideView; percent: string; group: EntityGroup; query: string }>()
const emit = defineEmits<{ open: [key: string] }>()
const { t } = useI18n()
const pageSize = 48
const limit = ref(pageSize)
const filtered = computed(() => props.view.groups[props.group].filter((entity) => matchesName(entity, props.query)))
const shown = computed(() => filtered.value.slice(0, limit.value))
watch([() => props.group, () => props.query], () => {
  limit.value = pageSize
})

function open(key: string) {
  emit('open', key)
}

function showMore() {
  limit.value += pageSize
}
</script>

<template>
  <div class="space-y-3">
    <header class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h2 class="text-base font-semibold">{{ t('book.detail.storyGuideTab.characterHeading') }}</h2>
      <span class="text-xs text-muted-foreground">{{ t('book.detail.storyGuideTab.characterAside', { percent }) }}</span>
    </header>

    <div class="grid grid-cols-[repeat(auto-fit,minmax(min(100%,15rem),1fr))] gap-2.5">
      <StoryGuideEntityCard
        v-for="entity in shown"
        :key="entity.key"
        :entity="entity"
        :since="view.chapterTitle(entity.firstSeen)"
        :query="query"
        @open="open"
      />
    </div>
    <p v-if="!shown.length" class="text-sm text-muted-foreground">{{ t('book.detail.storyGuideTab.noNames') }}</p>
    <button
      v-else-if="shown.length < filtered.length"
      type="button"
      class="rounded-md border border-input bg-background px-3 py-1.5 text-sm hover:bg-muted"
      @click="showMore"
    >
      {{ t('book.detail.storyGuideTab.showMore') }}
    </button>
  </div>
</template>

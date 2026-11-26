<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Search } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { entityKindColor, entityKindIcon } from '../lib/entity-kind-icon'
import type { EntityGroup, StoryGuideView } from '../lib/story-guide-view'

const props = defineProps<{ view: StoryGuideView; percent: string }>()
const emit = defineEmits<{ open: [key: string] }>()
const { t } = useI18n()
const kinds: EntityGroup[] = ['people', 'places', 'terms']
const group = ref<EntityGroup>('people')
const query = ref('')
const pageSize = 48
const limit = ref(pageSize)
const filtered = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase()
  const entries = props.view.groups[group.value]
  return needle ? entries.filter(({ search }) => search.some((name) => name.includes(needle))) : entries
})
const shown = computed(() => filtered.value.slice(0, limit.value))
watch([group, query], () => {
  limit.value = pageSize
})

function selectGroup(kind: EntityGroup) {
  group.value = kind
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
    <div class="flex flex-wrap gap-2">
      <label class="flex min-w-0 grow items-center gap-2 rounded-md border border-input bg-background px-2.5 py-1.5 text-muted-foreground sm:grow-0">
        <Search class="size-3.5 shrink-0" aria-hidden="true" />
        <input
          v-model="query"
          type="search"
          class="min-w-0 w-full text-sm text-foreground outline-none"
          :aria-label="t('book.detail.storyGuideTab.search')"
          :placeholder="t('book.detail.storyGuideTab.search')"
        />
      </label>
      <div class="flex rounded-lg border border-border bg-card p-0.5" role="group" :aria-label="t('book.detail.storyGuideTab.characterHeading')">
        <button
          v-for="kind in kinds"
          :key="kind"
          type="button"
          class="rounded-md px-2 py-1 text-xs"
          :class="group === kind ? 'bg-muted font-semibold' : 'text-muted-foreground hover:bg-muted/60'"
          :aria-pressed="group === kind"
          @click="selectGroup(kind)"
        >
          {{ t(`book.detail.storyGuideTab.groups.${kind}`) }} <span class="tabular-nums text-muted-foreground">{{ view.groups[kind].length }}</span>
        </button>
      </div>
    </div>

    <div class="grid grid-cols-[repeat(auto-fit,minmax(min(100%,15rem),1fr))] gap-2.5">
      <button
        v-for="entity in shown"
        :key="entity.key"
        type="button"
        class="flex min-w-0 flex-col gap-1.5 rounded-xl border border-border bg-card px-3.5 py-3 text-start hover:bg-muted/60 focus-visible:outline-ring"
        @click="emit('open', entity.key)"
      >
        <span class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <component :is="entityKindIcon(entity.kind)" class="size-3.5 shrink-0" :class="entityKindColor(entity.kind)" aria-hidden="true" />
          <span class="min-w-0 font-semibold break-words">{{ entity.name }}</span>
          <span class="text-xs text-muted-foreground">{{
            t(`book.detail.storyGuideTab.kinds.${entity.kind}`, t('book.detail.storyGuideTab.kinds.term'))
          }}</span>
          <span
            class="ms-auto flex shrink-0 items-end gap-0.5"
            :aria-label="t(`book.detail.storyGuideTab.importance.${entity.importance}`)"
            role="img"
          >
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
          >{{ t('book.detail.storyGuideTab.alsoKnownAs') }} {{ entity.aliases.map(({ name }) => name).join(', ') }}</span
        >
        <span class="line-clamp-3 text-sm break-words" :class="{ 'text-muted-foreground': !entity.profiles.length }">
          {{ entity.profiles[0]?.text ?? t('book.detail.storyGuideTab.noProfile') }}
        </span>
        <span class="mt-auto pt-1 text-xs tabular-nums text-muted-foreground">{{
          t('book.detail.storyGuideTab.since', { chapter: view.chapterTitle(entity.firstSeen) })
        }}</span>
      </button>
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

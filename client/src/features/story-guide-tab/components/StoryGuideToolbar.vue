<script setup lang="ts">
import { ref } from 'vue'
import { Ellipsis, Search, X } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { storyGuideActionLabel } from '@/features/story-guide/lib/story-guide-copy'
import type { StoryGuideAction } from '@/features/story-guide/lib/story-guide-presentation'
import type { ChapterOrder, ChapterPageSize } from '../lib/chapter-page'
import { entityKindColor, entityKindIcon } from '../lib/entity-kind-icon'
import { ENTITY_GROUPS } from '../lib/story-guide-search'
import type { EntityGroup } from '../lib/story-guide-view'
import StoryGuidePageControls from './StoryGuidePageControls.vue'

const KIND_ICON: Record<EntityGroup, string> = { people: 'character', places: 'place', terms: 'object' }

const props = defineProps<{
  placeholder: string
  /** Pressed kinds. On Characters the kinds act as one switch, so exactly one is pressed. */
  kinds: ReadonlySet<EntityGroup>
  counts: Record<EntityGroup, number>
  /** Chapters the current list pages through, or null where the section has no chapter paging. */
  pagedTotal: number | null
  actions: readonly StoryGuideAction[]
  pending: boolean
}>()
const query = defineModel<string>('query', { required: true })
const order = defineModel<ChapterOrder>('order', { required: true })
const size = defineModel<ChapterPageSize>('size', { required: true })
const emit = defineEmits<{ toggleKind: [kind: EntityGroup]; request: [action: StoryGuideAction] }>()
const { t } = useI18n()
const input = ref<HTMLInputElement | null>(null)

function clear() {
  query.value = ''
  input.value?.focus()
}

function toggle(kind: EntityGroup) {
  emit('toggleKind', kind)
}

function request(action: StoryGuideAction) {
  emit('request', action)
}

function pressed(kind: EntityGroup) {
  return props.kinds.has(kind)
}
</script>

<template>
  <div
    role="toolbar"
    :aria-label="t('book.detail.storyGuideTab.toolbar')"
    class="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-1.5"
    data-testid="story-guide-toolbar"
  >
    <div
      class="flex h-8 min-w-0 grow basis-48 items-center gap-2 rounded-md border border-input bg-background px-2.5 text-muted-foreground focus-within:border-ring"
    >
      <Search class="size-3.5 shrink-0" aria-hidden="true" />
      <input
        ref="input"
        v-model="query"
        type="search"
        class="min-w-0 w-full bg-transparent text-sm text-foreground outline-none [&::-webkit-search-cancel-button]:hidden"
        :aria-label="placeholder"
        :placeholder="placeholder"
        data-testid="story-guide-search"
      />
      <button
        v-if="query"
        type="button"
        class="shrink-0 rounded p-0.5 hover:bg-muted"
        :aria-label="t('book.detail.storyGuideTab.clearSearch')"
        @click="clear"
      >
        <X class="size-3.5" aria-hidden="true" />
      </button>
    </div>
    <DropdownMenu v-if="actions.length">
      <DropdownMenuTrigger as-child>
        <button
          type="button"
          class="inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-input bg-background hover:bg-muted @[47.5rem]/book-detail:order-last"
          :aria-label="t('book.detail.storyGuide.menu')"
          :disabled="pending"
        >
          <Ellipsis class="size-4" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem v-for="action in actions" :key="action" @select="request(action)">{{ storyGuideActionLabel(action) }}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <span class="basis-full @[47.5rem]/book-detail:hidden" aria-hidden="true" />
    <div
      class="flex rounded-lg border border-border bg-background p-0.5"
      role="group"
      :aria-label="t('book.detail.storyGuideTab.kindsLabel')"
      data-testid="story-guide-kinds"
    >
      <button
        v-for="kind in ENTITY_GROUPS"
        :key="kind"
        type="button"
        class="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs whitespace-nowrap"
        :class="pressed(kind) ? 'bg-muted font-semibold' : 'text-muted-foreground hover:bg-muted/60'"
        :aria-pressed="pressed(kind)"
        @click="toggle(kind)"
      >
        <component
          :is="entityKindIcon(KIND_ICON[kind])"
          class="hidden size-3 shrink-0 sm:block"
          :class="entityKindColor(KIND_ICON[kind])"
          aria-hidden="true"
        />{{ t(`book.detail.storyGuideTab.groups.${kind}`) }}
        <span class="font-normal tabular-nums text-muted-foreground">{{ counts[kind] }}</span>
      </button>
    </div>
    <StoryGuidePageControls v-if="pagedTotal !== null" v-model:order="order" v-model:size="size" :total="pagedTotal" class="ms-auto" />
  </div>
</template>

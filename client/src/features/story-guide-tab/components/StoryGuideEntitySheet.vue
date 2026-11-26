<script setup lang="ts">
import { computed } from 'vue'
import { X } from '@lucide/vue'
import { DialogClose, DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import { useI18n } from 'vue-i18n'
import { entityKindColor, entityKindIcon } from '../lib/entity-kind-icon'
import type { EntityView, StoryGuideView } from '../lib/story-guide-view'

const props = defineProps<{ entity: EntityView | undefined; view: StoryGuideView }>()
const emit = defineEmits<{ open: [key: string]; close: [] }>()
const { t } = useI18n()
const details = computed(() => props.entity && props.view.details(props.entity.key))

function handleOpenChange(open: boolean) {
  if (!open) emit('close')
}
</script>

<template>
  <DialogRoot :open="!!entity" @update:open="handleOpenChange">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-scrim" />
      <DialogContent
        v-if="entity && details"
        :aria-describedby="undefined"
        class="fixed inset-y-0 end-0 z-50 flex w-full flex-col border-border bg-card shadow-2xl sm:max-w-md sm:border-s"
      >
        <header class="flex items-start justify-between gap-3 border-b border-border p-4 pt-[max(1rem,env(safe-area-inset-top))]">
          <div class="min-w-0">
            <DialogTitle class="text-lg font-semibold break-words">{{ entity.name }}</DialogTitle>
            <p class="mt-1 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
              <span class="inline-flex items-center gap-1"
                ><component :is="entityKindIcon(entity.kind)" class="size-3 shrink-0" :class="entityKindColor(entity.kind)" aria-hidden="true" />{{
                  t(`book.detail.storyGuideTab.kinds.${entity.kind}`, t('book.detail.storyGuideTab.kinds.term'))
                }}</span
              >
              <span>{{ t(`book.detail.storyGuideTab.importance.${entity.importance}`) }}</span>
              <span>{{ t('book.detail.storyGuideTab.since', { chapter: view.chapterTitle(entity.firstSeen) }) }}</span>
            </p>
          </div>
          <DialogClose class="rounded-md p-1.5 hover:bg-muted" :aria-label="t('book.detail.storyGuideTab.close')">
            <X class="size-4" aria-hidden="true" />
          </DialogClose>
        </header>

        <div :key="entity.key" class="space-y-5 overflow-y-auto p-4 pb-[max(1rem,env(safe-area-inset-bottom))] text-sm">
          <section v-if="entity.aliases.length">
            <h3 class="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {{ t('book.detail.storyGuideTab.alsoKnownAs') }}
            </h3>
            <div class="flex flex-wrap gap-1.5">
              <span
                v-for="alias in entity.aliases"
                :key="alias.name"
                class="inline-flex flex-wrap items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-xs"
              >
                <component :is="entityKindIcon(entity.kind)" class="size-3 shrink-0" :class="entityKindColor(entity.kind)" aria-hidden="true" />
                {{ alias.name }}
                <span class="text-muted-foreground">{{ view.chapterTitle(alias.s) }}</span>
              </span>
            </div>
          </section>
          <section>
            <h3 class="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{{ t('book.detail.storyGuideTab.who') }}</h3>
            <ul v-if="entity.profiles.length" class="divide-y divide-border rounded-lg border border-border">
              <li v-for="(profile, index) in entity.profiles" :key="index" class="space-y-0.5 px-2.5 py-2">
                <span class="block truncate text-xs text-muted-foreground">{{
                  index > 0
                    ? view.chapterTitle(profile.s)
                    : entity.lastSeen
                      ? t('book.detail.storyGuideTab.lastSeen', { chapter: entity.lastSeen })
                      : t('book.detail.storyGuideTab.now')
                }}</span>
                <span class="block" :class="{ 'text-muted-foreground': index > 0 }">{{ profile.text }}</span>
              </li>
            </ul>
            <p v-else class="text-muted-foreground">{{ t('book.detail.storyGuideTab.noProfile') }}</p>
            <p v-if="!entity.profiles.length && entity.lastSeen" class="mt-1 text-xs text-muted-foreground">
              {{ t('book.detail.storyGuideTab.lastSeen', { chapter: entity.lastSeen }) }}
            </p>
          </section>
          <section v-if="details.recent.length">
            <h3 class="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{{ t('book.detail.storyGuideTab.recent') }}</h3>
            <ul class="divide-y divide-border rounded-lg border border-border">
              <li v-for="note in details.recent" :key="`${note.s}:${note.text}`" class="space-y-0.5 px-2.5 py-2">
                <span class="block truncate text-xs text-muted-foreground">{{ view.chapterTitle(note.s) }}</span>
                <span class="block">{{ note.text }}</span>
              </li>
            </ul>
          </section>
          <section v-if="details.groups.length" class="space-y-2">
            <h3 class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{{ t('book.detail.storyGuideTab.ties') }}</h3>
            <div v-for="group in details.groups" :key="group.group" class="divide-y divide-border rounded-lg border border-border">
              <h4 class="px-2.5 py-1 text-xs font-medium text-muted-foreground">{{ t(`book.detail.storyGuideTab.tieGroups.${group.group}`) }}</h4>
              <button
                v-for="tie in group.ties"
                :key="tie.key"
                type="button"
                class="flex w-full gap-2 px-2.5 py-2 text-start hover:bg-muted"
                @click="emit('open', tie.a.key === entity.key ? tie.b.key : tie.a.key)"
              >
                <span class="min-w-0 flex-1 break-words">
                  <component
                    :is="entityKindIcon(tie.a.kind)"
                    class="me-1 inline size-3 align-[-1px]"
                    :class="entityKindColor(tie.a.kind)"
                    aria-hidden="true"
                  /><strong>{{ tie.a.name }}</strong>
                  {{ tie.label }}
                  <component
                    :is="entityKindIcon(tie.b.kind)"
                    class="me-1 inline size-3 align-[-1px]"
                    :class="entityKindColor(tie.b.kind)"
                    aria-hidden="true"
                  /><strong>{{ tie.b.name }}</strong>
                  <span v-if="tie.note" class="block text-xs text-muted-foreground">{{ tie.note }}</span>
                  <span v-else-if="tie.quotes[0] && 'q' in tie.quotes[0]" class="block text-xs text-muted-foreground">{{ tie.quotes[0].q }}</span>
                </span>
                <span class="text-xs tabular-nums text-muted-foreground">{{ tie.quotes.length }}×</span>
              </button>
            </div>
          </section>
          <section v-if="details.often.size">
            <h3 class="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{{ t('book.detail.storyGuideTab.often') }}</h3>
            <div class="flex flex-wrap gap-1.5">
              <button
                v-for="other in details.often"
                :key="other.key"
                type="button"
                class="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-xs hover:bg-accent"
                @click="emit('open', other.key)"
              >
                <component :is="entityKindIcon(other.kind)" class="size-3 shrink-0" :class="entityKindColor(other.kind)" aria-hidden="true" />
                {{ other.name }}
              </button>
            </div>
          </section>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

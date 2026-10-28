<script setup lang="ts">
import { computed } from 'vue'
import { BookOpen, ChevronDown, ChevronRight } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import type { EditionLinkMatch, EditionLinkMatchBook } from '@bookorbit/types'

import BookCoverImage from '@/features/book/components/BookCoverImage.vue'
import WorkRoleChip from '@/features/edition-link/components/WorkRoleChip.vue'
import { variantChipCode } from '@/features/edition-link/lib/work-roles'
import EditionLinkActions from './EditionLinkActions.vue'
import EditionLinkCompareBench from './EditionLinkCompareBench.vue'
import EditionLinkMatchChip from './EditionLinkMatchChip.vue'

const props = defineProps<{ match: EditionLinkMatch; expanded: boolean; busy: boolean }>()
const emit = defineEmits<{ expand: [matchId: number]; link: [matchId: number]; dismiss: [matchId: number]; unlink: [matchId: number] }>()

const { t } = useI18n()

const title = computed(() => props.match.source.title?.trim() || t('book.untitled'))
const author = computed(() => props.match.source.authorName ?? t('tools.editionLinks.unknownAuthor'))
const libraries = computed(() => [...new Set([props.match.source.libraryName, props.match.target.libraryName])].join(', '))
const proposed = computed(() => props.match.linkId === null)
const covers = computed(() => [props.match.source, props.match.target])

function chipLabel(book: EditionLinkMatchBook): string {
  return variantChipCode(book, t(`book.detail.editionLink.work.role.${book.role}`))
}

function handleExpand(): void {
  emit('expand', props.match.id)
}

function handleLink(matchId: number): void {
  emit('link', matchId)
}

function handleDismiss(matchId: number): void {
  emit('dismiss', matchId)
}

function handleUnlink(matchId: number): void {
  emit('unlink', matchId)
}
</script>

<template>
  <li class="border-b border-border/60 last:border-b-0" :data-match-id="match.id" data-testid="match-row">
    <div class="edition-row items-center gap-2.5 px-3 py-2 transition-colors hover:bg-accent/60">
      <EditionLinkMatchChip class="edition-cell-match" :bucket="match.bucket" :score="match.score" />

      <div class="edition-cell-work flex min-w-0 items-center gap-2.5">
        <span class="flex shrink-0" aria-hidden="true">
          <span
            v-for="(book, index) in covers"
            :key="book.id"
            class="grid h-[34px] w-6 place-items-center overflow-hidden rounded-[3px] border border-border bg-muted"
            :class="index > 0 ? '-ms-3.5 shadow-[-2px_0_3px_oklch(0_0_0/0.25)]' : ''"
          >
            <BookCoverImage
              v-if="book.coverVersion !== null"
              :book-id="book.id"
              :version="book.coverVersion"
              class="h-full w-full object-cover"
              alt=""
            />
            <BookOpen v-else class="size-3 text-muted-foreground" />
          </span>
        </span>
        <span class="min-w-0">
          <RouterLink
            :to="{ name: 'book-detail', params: { bookId: match.source.id } }"
            class="block truncate text-[13px] font-semibold text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {{ title }}
          </RouterLink>
          <span class="mt-0.5 block truncate text-[11.5px] text-muted-foreground">{{ author }}</span>
          <span class="block truncate text-[11.5px] text-muted-foreground">{{ match.reason }}</span>
        </span>
      </div>

      <span class="edition-cell-variants flex flex-wrap items-center gap-1">
        <WorkRoleChip :role="match.source.role" :label="chipLabel(match.source)" />
        <WorkRoleChip :role="match.target.role" :label="chipLabel(match.target)" :dashed="proposed" />
      </span>

      <span class="edition-cell-library truncate text-[12px] text-muted-foreground">{{ libraries }}</span>

      <EditionLinkActions
        class="edition-cell-actions"
        :match="match"
        :busy="busy"
        @link="handleLink"
        @dismiss="handleDismiss"
        @unlink="handleUnlink"
      />

      <button
        type="button"
        class="edition-cell-expand grid size-[30px] place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        :aria-expanded="expanded"
        :aria-label="t('tools.editionLinks.compare', { title })"
        @click="handleExpand"
      >
        <ChevronDown v-if="expanded" class="size-4" aria-hidden="true" />
        <ChevronRight v-else class="size-4" aria-hidden="true" />
      </button>
    </div>

    <div v-if="expanded" class="border-t border-dashed border-border/80 bg-secondary/40 px-3 py-3">
      <EditionLinkCompareBench :match="match" />
      <EditionLinkActions class="mt-3" :match="match" :busy="busy" @link="handleLink" @dismiss="handleDismiss" @unlink="handleUnlink" />
    </div>
  </li>
</template>

<style scoped>
.edition-row {
  display: grid;
  grid-template-columns: 150px minmax(0, 1fr) 150px 140px 290px 30px;
}

@container editionlinks (max-width: 1240px) {
  .edition-row {
    grid-template-columns: 150px minmax(0, 1fr) 150px 290px 30px;
  }
  .edition-cell-library {
    display: none;
  }
}

@container editionlinks (max-width: 1000px) {
  .edition-row {
    grid-template-columns: 140px minmax(0, 1fr) 30px;
  }
  .edition-cell-variants,
  .edition-cell-actions {
    display: none;
  }
}

@container editionlinks (max-width: 700px) {
  .edition-row {
    grid-template-columns: minmax(0, 1fr) 30px;
    align-items: start;
  }
  .edition-cell-match {
    grid-row: 2;
    justify-self: start;
  }
  .edition-cell-work {
    grid-row: 1;
  }
  .edition-cell-expand {
    grid-column: 2;
    grid-row: 1 / span 2;
  }
}
</style>

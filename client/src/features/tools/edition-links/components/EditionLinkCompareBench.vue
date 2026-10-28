<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { EditionLinkMatch, EditionLinkMatchBook } from '@bookorbit/types'

import { formatPercent } from '@/i18n/formatters'
import { variantChipCode } from '@/features/edition-link/lib/work-roles'
import WorkRoleChip from '@/features/edition-link/components/WorkRoleChip.vue'

const READ_STATUS_KEYS: Record<string, string> = { want_to_read: 'wantToRead', on_hold: 'onHold' }

const props = defineProps<{ match: EditionLinkMatch }>()

const { t } = useI18n()

const books = computed<EditionLinkMatchBook[]>(() => [props.match.source, props.match.target])

interface Field {
  key: string
  value: (book: EditionLinkMatchBook) => string
}

const none = computed(() => t('tools.editionLinks.unknown'))

const fields = computed<Field[]>(() => [
  { key: 'title', value: (book) => book.title ?? none.value },
  { key: 'author', value: (book) => book.authorName ?? none.value },
  {
    key: 'series',
    value: (book) => (book.seriesName ? (book.seriesIndex ? `${book.seriesName} #${book.seriesIndex}` : book.seriesName) : none.value),
  },
  { key: 'isbn', value: (book) => book.isbn ?? none.value },
  { key: 'library', value: (book) => book.libraryName },
  {
    key: 'status',
    value: (book) => {
      const status = book.readStatus ? t(`book.readStatus.${READ_STATUS_KEYS[book.readStatus] ?? book.readStatus}`) : none.value
      return book.progress === null ? status : `${status} · ${formatPercent(Math.max(0, Math.min(100, book.progress)) / 100)}`
    },
  },
])

function chipLabel(book: EditionLinkMatchBook): string {
  return variantChipCode(book, t(`book.detail.editionLink.work.role.${book.role}`))
}
</script>

<template>
  <table class="w-full max-w-[900px] table-fixed border-collapse text-[12.5px]" data-testid="compare-bench">
    <caption class="sr-only">
      {{
        t('tools.editionLinks.compareCaption')
      }}
    </caption>
    <thead>
      <tr>
        <th class="w-[92px]" scope="col">
          <span class="sr-only">{{ t('tools.editionLinks.fieldColumn') }}</span>
        </th>
        <th v-for="book in books" :key="book.id" class="p-1 pb-2 text-start align-top" scope="col">
          <span class="flex items-center gap-2">
            <WorkRoleChip :role="book.role" :label="chipLabel(book)" :dashed="book.id === match.target.id && match.linkId === null" />
            <RouterLink
              :to="{ name: 'book-detail', params: { bookId: book.id } }"
              class="truncate text-[11.5px] font-normal text-muted-foreground hover:underline"
            >
              {{ t('tools.editionLinks.openBook') }}
            </RouterLink>
          </span>
        </th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="field in fields" :key="field.key">
        <th
          class="border-t border-border/65 py-1.5 pe-2 text-start align-top text-[10.5px] font-bold tracking-wide uppercase text-muted-foreground"
          scope="row"
        >
          {{ t(`tools.editionLinks.fields.${field.key}`) }}
        </th>
        <td v-for="book in books" :key="book.id" class="border-t border-border/65 px-2 py-1.5 align-top break-words">
          {{ field.value(book) }}
        </td>
      </tr>
    </tbody>
  </table>
</template>

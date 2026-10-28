<script setup lang="ts">
import { computed } from 'vue'
import { Undo2 } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import type { EditionLinkMatchDismissal } from '@bookorbit/types'

import { formatDate } from '@/i18n/formatters'

const props = defineProps<{ dismissals: EditionLinkMatchDismissal[]; open: boolean }>()
const emit = defineEmits<{ toggle: []; restore: [bookIdA: number, bookIdB: number] }>()

const { t } = useI18n()
const count = computed(() => props.dismissals.length)

function handleToggle(): void {
  emit('toggle')
}

function handleRestore(event: MouseEvent): void {
  const { a, b } = (event.currentTarget as HTMLElement).dataset
  emit('restore', Number(a), Number(b))
}
</script>

<template>
  <section v-if="count > 0" class="shrink-0">
    <button
      type="button"
      class="rounded-md text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      :aria-expanded="open"
      @click="handleToggle"
    >
      {{ open ? t('tools.editionLinks.dismissed.hide') : t('tools.editionLinks.dismissed.show', { count }, count) }}
    </button>

    <ul v-if="open" class="mt-2 grid max-h-52 gap-1 overflow-y-auto">
      <li
        v-for="dismissal in dismissals"
        :key="`${dismissal.bookIdA}-${dismissal.bookIdB}`"
        class="flex items-center gap-2 rounded-lg bg-secondary px-2.5 py-1.5 text-[12px]"
      >
        <span class="min-w-0 flex-1 truncate text-foreground">
          {{ t('tools.editionLinks.pairLabel', { first: dismissal.titleA ?? t('book.untitled'), second: dismissal.titleB ?? t('book.untitled') }) }}
        </span>
        <span class="shrink-0 text-muted-foreground">{{ formatDate(new Date(dismissal.createdAt)) }}</span>
        <button
          type="button"
          class="grid size-6 shrink-0 place-items-center rounded-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          :data-a="dismissal.bookIdA"
          :data-b="dismissal.bookIdB"
          :aria-label="t('tools.editionLinks.dismissed.restore')"
          @click="handleRestore"
        >
          <Undo2 class="size-3.5" aria-hidden="true" />
        </button>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ReleaseSearchProgress } from '@bookorbit/types'
const props = defineProps<{
  query: { title: string; author: string }
  altTitles: string[]
  searching: boolean
  indexers: ReleaseSearchProgress['indexers']
  pending: ReleaseSearchProgress['pending']
  resultCount: number
}>()
const emit = defineEmits<{ search: [query: { title: string; author: string }] }>()
const title = ref(props.query.title)
const author = ref(props.query.author)
watch(
  () => props.query,
  (query) => {
    title.value = query.title
    author.value = query.author
  },
)
const otherTitles = computed(() => {
  const seen = new Set([props.query.title.trim().toLocaleLowerCase()])
  return props.altTitles
    .filter((value) => {
      const key = value.trim().toLocaleLowerCase()
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 6)
})
function fillTitle(value: string) {
  title.value = value
}
const { t } = useI18n()
const total = computed(() => props.indexers.length + props.pending.length)
const chips = computed(() => [
  ...props.indexers.map((ix) => ({
    id: ix.indexerId,
    name: ix.indexerName,
    label: ix.failure === 'timeout' ? t('webSerials.acquisition.timedOut') : ix.failure ? t('webSerials.acquisition.failed') : String(ix.count),
    tone:
      ix.failure === 'timeout'
        ? 'bg-warning/10 text-warning'
        : ix.failure
          ? 'bg-destructive/10 text-destructive'
          : ix.count
            ? 'bg-success/10 text-success'
            : 'bg-muted text-muted-foreground',
    running: false,
  })),
  ...props.pending.map((ix) => ({
    id: ix.indexerId,
    name: ix.indexerName,
    label: t('webSerials.acquisition.searchingChip'),
    tone: 'bg-primary/10 text-primary',
    running: true,
  })),
])
function search() {
  if (!props.searching && title.value.trim()) emit('search', { title: title.value.trim(), author: author.value.trim() })
}
</script>
<template>
  <section class="flex flex-col gap-2.5 rounded-xl border border-border bg-card px-4 py-3.5" aria-live="polite" :aria-busy="searching">
    <div class="flex items-center gap-2.5">
      <span class="flex-1 text-sm font-semibold">{{
        searching ? t('webSerials.acquisition.searching', total) : t('webSerials.acquisition.searched', { count: total, results: resultCount }, total)
      }}</span>
    </div>
    <form class="flex flex-wrap items-end gap-2" @submit.prevent="search">
      <label class="min-w-40 flex-1 text-xs">
        {{ t('webSerials.acquisition.search.title') }}
        <input v-model="title" class="input-field mt-1 w-full" maxlength="500" required />
      </label>
      <label class="min-w-32 flex-1 text-xs">
        {{ t('webSerials.acquisition.search.author') }}
        <input v-model="author" class="input-field mt-1 w-full" maxlength="255" />
      </label>
      <button type="submit" class="h-9 rounded-lg border border-border px-3 text-xs" :disabled="searching">
        {{ t('webSerials.acquisition.search.submit') }}
      </button>
    </form>
    <div v-if="otherTitles.length" class="flex flex-wrap items-center gap-2 text-xs">
      <span>{{ t('webSerials.acquisition.search.otherTitles') }}</span>
      <button v-for="altTitle in otherTitles" :key="altTitle" type="button" class="rounded-full bg-muted px-2.5 py-1" @click="fillTitle(altTitle)">
        {{ altTitle }}
      </button>
    </div>
    <div v-if="searching" data-testid="search-sweep" class="h-1 overflow-hidden rounded bg-muted">
      <div class="h-full w-2/5 rounded bg-primary motion-safe:animate-[ln-sweep_1.5s_ease-in-out_infinite]" />
    </div>
    <div class="flex flex-wrap gap-2">
      <span v-for="chip in chips" :key="chip.id" class="inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs" :class="chip.tone"
        ><span class="size-1.5 rounded-full bg-current" :class="chip.running ? 'motion-safe:animate-pulse' : ''" />{{ chip.name }} ·
        {{ chip.label }}</span
      >
    </div>
  </section>
</template>
<style>
@keyframes ln-sweep {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(350%);
  }
}
</style>

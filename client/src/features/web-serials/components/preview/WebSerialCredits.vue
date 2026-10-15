<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, ExternalLink, Loader2, TriangleAlert } from '@lucide/vue'
import type { WebSerialSeriesMatch } from '@bookorbit/types'
import ChipInput from '@/components/ui/ChipInput.vue'

const props = defineProps<{
  state: string
  match: WebSerialSeriesMatch | null
  message: string
  authors: string[]
  artists: string[]
  showArtists: boolean
}>()

const emit = defineEmits<{
  'update:authors': [values: string[]]
  'update:artists': [values: string[]]
  reject: []
  restore: []
  retry: []
}>()

const { t } = useI18n()

const matchedLabel = computed(() => {
  const match = props.match
  if (!match) return ''
  if (match.scope === 'part') return t('webSerials.preview.lookup.matchedFirstPart', { title: match.title })
  return match.year === null
    ? t('webSerials.preview.lookup.matchedNoYear', { title: match.title })
    : t('webSerials.preview.lookup.matched', { title: match.title, year: match.year })
})

function handleAuthors(values: string[]) {
  emit('update:authors', values)
}

function handleArtists(values: string[]) {
  emit('update:artists', values)
}

function handleReject() {
  emit('reject')
}

function handleRestore() {
  emit('restore')
}

function handleRetry() {
  emit('retry')
}
</script>

<template>
  <section class="space-y-2.5" :aria-label="t('webSerials.preview.credits')">
    <div class="grid grid-cols-1 gap-2.5" :class="showArtists ? 'sm:grid-cols-2' : ''">
      <div class="flex min-w-0 flex-col gap-1">
        <label for="web-serials-authors" class="text-xs text-muted-foreground">{{ t('webSerials.preview.authors') }}</label>
        <ChipInput
          input-id="web-serials-authors"
          :model-value="authors"
          :placeholder="t('webSerials.preview.authorsPlaceholder')"
          @update:model-value="handleAuthors"
        />
      </div>
      <div v-if="showArtists" class="flex min-w-0 flex-col gap-1">
        <label for="web-serials-artists" class="text-xs text-muted-foreground">{{ t('webSerials.preview.artists') }}</label>
        <ChipInput
          input-id="web-serials-artists"
          :model-value="artists"
          :placeholder="t('webSerials.preview.artistsPlaceholder')"
          @update:model-value="handleArtists"
        />
      </div>
    </div>

    <p v-if="state === 'loading'" class="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
      <Loader2 class="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      {{ t('webSerials.preview.lookup.loading') }}
    </p>

    <p v-else-if="state === 'matched' && match" class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
      <Check class="size-3 shrink-0 text-success" :stroke-width="2.5" aria-hidden="true" />
      <a :href="match.url" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 hover:text-foreground hover:underline">
        {{ matchedLabel }}
        <ExternalLink class="size-3 shrink-0" aria-hidden="true" />
      </a>
      <button
        type="button"
        class="font-medium text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        @click="handleReject"
      >
        {{ t('webSerials.preview.lookup.notThisSeries') }}
      </button>
    </p>

    <p v-else-if="state === 'rejected'" class="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
      {{ t('webSerials.preview.lookup.rejected') }}
      <button
        type="button"
        class="font-medium text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        @click="handleRestore"
      >
        {{ t('webSerials.preview.lookup.useMatch') }}
      </button>
    </p>

    <p v-else-if="state === 'no_match'" class="text-xs text-muted-foreground">{{ t('webSerials.preview.lookup.noMatch') }}</p>

    <p v-else-if="state === 'unavailable'" class="flex flex-wrap items-center gap-x-2 text-xs text-warning" role="status">
      <span class="inline-flex items-center gap-1.5">
        <TriangleAlert class="size-3 shrink-0" aria-hidden="true" />
        {{ message }}
      </span>
      <button
        type="button"
        class="font-medium text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        @click="handleRetry"
      >
        {{ t('common.retry') }}
      </button>
    </p>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { cleanTags } from '../../lib/serialTags'

const COLLAPSED_COUNT = 5

const props = defineProps<{ genres: string[]; tags: string[] }>()

const { t } = useI18n()
const expanded = ref(false)
const all = computed(() => cleanTags(props.genres, props.tags))
const shown = computed(() => (expanded.value ? all.value : all.value.slice(0, COLLAPSED_COUNT)))
const hiddenCount = computed(() => all.value.length - COLLAPSED_COUNT)

watch(all, () => {
  expanded.value = false
})

function handleToggle() {
  expanded.value = !expanded.value
}
</script>

<template>
  <div v-if="all.length > 0" class="flex gap-1.5" :class="expanded ? 'items-start' : 'items-center'">
    <ul class="flex min-w-0 gap-1.5" :class="expanded ? 'flex-wrap' : 'overflow-hidden'" :aria-label="t('webSerials.preview.tags')">
      <li
        v-for="tag in shown"
        :key="tag"
        class="rounded-full border border-border bg-muted px-2 py-0.5 text-xs whitespace-nowrap text-muted-foreground"
        :class="expanded ? '' : 'shrink-0'"
      >
        {{ tag }}
      </li>
    </ul>
    <button
      v-if="hiddenCount > 0"
      type="button"
      class="shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      :aria-expanded="expanded"
      :aria-label="expanded ? t('webSerials.preview.tagsLess') : t('webSerials.preview.tagsMore', { count: hiddenCount })"
      @click="handleToggle"
    >
      {{ expanded ? t('webSerials.preview.less') : `+${hiddenCount}` }}
    </button>
  </div>
</template>

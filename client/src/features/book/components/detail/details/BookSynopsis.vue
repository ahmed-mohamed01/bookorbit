<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  /** Already sanitised HTML, or null when the book has no description. */
  html: string | null
  contentId: string
}>()

const { t } = useI18n()
const expanded = ref(false)

watch(
  () => props.contentId,
  () => {
    expanded.value = false
  },
)

function toggle() {
  expanded.value = !expanded.value
}
</script>

<template>
  <div>
    <div class="flex items-baseline gap-3">
      <p class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {{ t('book.detail.details.synopsis') }}
      </p>
      <button
        v-if="html"
        type="button"
        class="ml-auto shrink-0 text-[11px] font-semibold text-primary transition-colors hover:underline"
        :aria-controls="contentId"
        :aria-expanded="expanded"
        @click="toggle"
      >
        {{ expanded ? t('book.detail.details.showLess') : t('book.detail.details.showMore') }}
      </button>
    </div>
    <div
      v-if="html"
      :id="contentId"
      data-test="synopsis-copy"
      class="mt-2 text-sm leading-relaxed text-foreground"
      :class="{ 'synopsis-copy--clamped': !expanded }"
      v-html="html"
    />
    <p v-else class="mt-2 text-sm italic text-muted-foreground">{{ t('book.detail.details.noDescription') }}</p>
  </div>
</template>

<style scoped>
.synopsis-copy--clamped {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 4;
}

@media (min-height: 56rem) {
  .synopsis-copy--clamped {
    -webkit-line-clamp: 6;
  }
}

@media (min-height: 80rem) {
  .synopsis-copy--clamped {
    -webkit-line-clamp: 10;
  }
}
</style>

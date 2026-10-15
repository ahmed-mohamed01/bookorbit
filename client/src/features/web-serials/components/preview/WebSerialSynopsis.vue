<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const CLAMP_MIN_LENGTH = 140

const props = defineProps<{ synopsis: string }>()

const { t } = useI18n()
const expanded = ref(false)
const long = computed(() => props.synopsis.length > CLAMP_MIN_LENGTH || props.synopsis.includes('\n'))

watch(
  () => props.synopsis,
  () => {
    expanded.value = false
  },
)

function handleToggle() {
  expanded.value = !expanded.value
}
</script>

<template>
  <section class="rounded-xl border border-border bg-card px-4 py-3.5" :aria-label="t('webSerials.preview.synopsis')">
    <div class="flex items-baseline gap-3">
      <p class="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">{{ t('webSerials.preview.synopsis') }}</p>
      <button
        v-if="long"
        type="button"
        class="ms-auto shrink-0 text-[11px] font-semibold text-primary transition-colors hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        aria-controls="web-serial-synopsis"
        :aria-expanded="expanded"
        @click="handleToggle"
      >
        {{ expanded ? t('webSerials.preview.less') : t('webSerials.preview.more') }}
      </button>
    </div>
    <p
      id="web-serial-synopsis"
      data-testid="synopsis-copy"
      class="mt-2 text-sm leading-relaxed break-words whitespace-pre-line text-foreground"
      :class="expanded ? '' : 'line-clamp-2'"
    >
      {{ synopsis }}
    </p>
  </section>
</template>

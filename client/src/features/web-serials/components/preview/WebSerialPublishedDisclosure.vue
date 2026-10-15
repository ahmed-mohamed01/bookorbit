<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronRight } from '@lucide/vue'
import type { PublishedSeries } from '../../lib/publishedVolumes'
import WebSerialPublishedVolumes from './WebSerialPublishedVolumes.vue'

defineProps<{ series: PublishedSeries; reason: 'licensed' | 'unavailable' | null }>()

const { t } = useI18n()
const expanded = ref(false)

function handleToggle() {
  expanded.value = !expanded.value
}
</script>

<template>
  <div v-if="reason" data-testid="published-disclosure">
    <button
      type="button"
      class="inline-flex items-center gap-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      :aria-expanded="expanded"
      aria-controls="web-serial-published-panel"
      @click="handleToggle"
    >
      <ChevronRight
        class="size-3.5 shrink-0 transition-transform motion-reduce:transition-none"
        :class="expanded ? 'rotate-90' : ''"
        aria-hidden="true"
      />
      {{ t('webSerials.preview.published.alsoInPrint') }}
    </button>
    <div v-if="expanded" id="web-serial-published-panel" class="mt-2.5">
      <WebSerialPublishedVolumes :series="series" :reason="reason" />
    </div>
  </div>
</template>

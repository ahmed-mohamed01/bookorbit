<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { ChevronDown } from '@lucide/vue'
const props = defineProps<{ active: boolean; open: boolean }>()
const emit = defineEmits<{ 'update:open': [value: boolean] }>()
const { t } = useI18n()
function handleClick() {
  emit('update:open', !props.open)
}
</script>
<template>
  <section v-if="active" class="space-y-2.5" data-testid="web-sources-disclosure">
    <button
      type="button"
      class="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      :aria-expanded="open"
      @click="handleClick"
    >
      <ChevronDown class="size-3.5 transition-transform" :class="open ? 'rotate-180' : ''" aria-hidden="true" />
      {{ t('webSerials.acquisition.webSources') }}
    </button>
    <div v-if="open" class="space-y-2.5"><slot /></div>
  </section>
  <slot v-else />
</template>

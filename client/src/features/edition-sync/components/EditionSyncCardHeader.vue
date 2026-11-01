<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'

defineProps<{ modelValue: boolean; disabled?: boolean; title?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()

const { t } = useI18n()

function handleUpdate(value: boolean) {
  emit('update:modelValue', value)
}
</script>

<template>
  <ToggleSwitch
    :model-value="modelValue"
    :disabled="disabled"
    :title="title"
    :aria-label="t('editionSync.card.toggle')"
    @update:model-value="handleUpdate"
  />
</template>

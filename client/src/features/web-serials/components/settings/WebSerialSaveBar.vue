<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Loader2, Save } from '@lucide/vue'
import { Button } from '@/components/ui/button'

defineProps<{ invalid: boolean; saving: boolean }>()

const emit = defineEmits<{ save: []; discard: [] }>()

const { t } = useI18n()

function handleSave() {
  emit('save')
}

function handleDiscard() {
  emit('discard')
}
</script>

<template>
  <div class="sticky bottom-0 z-10 flex flex-wrap items-center gap-3 rounded-lg border border-primary/30 bg-primary/10 px-4 py-2.5 backdrop-blur">
    <p class="flex items-center gap-2 text-sm" :class="invalid ? 'text-destructive' : 'text-foreground'" role="status">
      <span class="size-2 shrink-0 rounded-full" :class="invalid ? 'bg-destructive' : 'bg-primary'" aria-hidden="true" />
      {{ invalid ? t('webSerials.settings.saveBar.invalid') : t('webSerials.settings.saveBar.unsaved') }}
    </p>
    <div class="ms-auto flex items-center gap-2">
      <Button variant="ghost" size="sm" type="button" :disabled="saving" @click="handleDiscard">
        {{ t('webSerials.settings.saveBar.discard') }}
      </Button>
      <Button size="sm" type="button" :disabled="invalid || saving" @click="handleSave">
        <Loader2 v-if="saving" class="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        <Save v-else class="size-3.5" aria-hidden="true" />
        {{ t('webSerials.settings.saveBar.save') }}
      </Button>
    </div>
  </div>
</template>

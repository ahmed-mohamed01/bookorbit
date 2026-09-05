<script setup lang="ts">
import { Bell, Plus } from '@lucide/vue'
import { Button } from '@/components/ui/button'

withDefaults(
  defineProps<{
    title: string
    description: string
    actionLabel?: string
  }>(),
  { actionLabel: undefined },
)

const emit = defineEmits<{ action: [] }>()

function handleAction() {
  emit('action')
}
</script>

<template>
  <div class="flex min-h-72 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/45 px-6 py-12 text-center">
    <div class="flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
      <Bell :size="22" />
    </div>
    <h2 class="mt-4 text-base font-semibold text-foreground">{{ title }}</h2>
    <p class="mt-1 max-w-md text-sm text-muted-foreground">{{ description }}</p>
    <Button v-if="actionLabel" class="mt-5" @click="handleAction">
      <Plus :size="16" />
      {{ actionLabel }}
    </Button>
  </div>
</template>

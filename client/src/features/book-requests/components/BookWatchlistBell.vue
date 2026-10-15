<script setup lang="ts">
import { Bell } from '@lucide/vue'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/** The watchlist's mark on a missing-format row: a status icon whose tooltip says how the work is watched. */
defineProps<{ label: string }>()
</script>

<template>
  <Tooltip>
    <TooltipTrigger as-child>
      <span
        class="inline-flex shrink-0 items-center justify-center rounded-xs text-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        tabindex="0"
        role="img"
        :aria-label="label"
      >
        <Bell :size="12" aria-hidden="true" />
      </span>
    </TooltipTrigger>
    <TooltipContent>{{ label }}</TooltipContent>
  </Tooltip>
</template>

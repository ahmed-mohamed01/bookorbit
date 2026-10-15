<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

const MAX_VISIBLE = 3

const props = defineProps<{ tags: string[] }>()

const { t } = useI18n()
const visible = computed(() => props.tags.slice(0, MAX_VISIBLE))
const hidden = computed(() => props.tags.slice(MAX_VISIBLE))
</script>

<template>
  <div v-if="tags.length" class="mt-2 flex flex-wrap items-center gap-1.5" data-testid="work-tags">
    <span v-for="tag in visible" :key="tag" data-testid="work-tag" class="chip-genre rounded-md px-2 py-0.5 text-[11px] font-medium">{{ tag }}</span>
    <TooltipProvider v-if="hidden.length">
      <Tooltip>
        <TooltipTrigger as-child>
          <button
            type="button"
            data-testid="work-tags-more"
            class="rounded-md border border-border px-2 py-0.5 text-[11px] font-medium text-foreground transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            :aria-label="t('book.detail.details.moreCount', { count: hidden.length })"
          >
            +{{ hidden.length }}
          </button>
        </TooltipTrigger>
        <TooltipContent class="max-w-64">{{ hidden.join(', ') }}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  </div>
</template>

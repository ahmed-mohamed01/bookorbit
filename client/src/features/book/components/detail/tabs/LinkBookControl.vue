<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Link2 } from '@lucide/vue'
import type { BookDetail } from '@bookorbit/types'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useLinkEditionPanel } from '@/features/book/composables/useLinkEditionPanel'
import LinkEditionPanel from './edition-link/LinkEditionPanel.vue'

const props = withDefaults(defineProps<{ book: BookDetail; triggerClass?: string }>(), {
  triggerClass: 'flex flex-1 items-center justify-center h-9 rounded-md border border-input bg-background text-sm hover:bg-muted transition-colors',
})

const { t } = useI18n()

const panel = reactive(useLinkEditionPanel(() => props.book))

onMounted(() => {
  if (panel.isEligible) void panel.loadInitial()
})

const open = ref(false)

function handleOpenChange(next: boolean) {
  open.value = next
  if (next) void panel.handleOpen()
}
</script>

<template>
  <Popover v-if="panel.isEligible" :open="open" @update:open="handleOpenChange">
    <PopoverTrigger as-child>
      <button type="button" :class="triggerClass" :title="panel.triggerTooltip" :aria-label="t('book.detail.editionLink.trigger')">
        <Link2 class="size-3.5" :class="panel.triggerIconClass" />
      </button>
    </PopoverTrigger>
    <PopoverContent
      align="end"
      :collision-padding="16"
      class="max-h-(--reka-popover-content-available-height) w-[26rem] max-w-[calc(100vw-2rem)] overflow-y-auto p-4"
    >
      <LinkEditionPanel :panel="panel" />
    </PopoverContent>
  </Popover>
</template>

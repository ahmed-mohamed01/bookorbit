<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Link2 } from '@lucide/vue'
import type { BookDetail } from '@bookorbit/types'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useSyncChainPanel } from '@/features/book/composables/useSyncChainPanel'
import { availableHeightFromTrigger } from '@/features/book/lib/sync-chain'
import SyncChainPanel from './edition-link/SyncChainPanel.vue'

const props = withDefaults(defineProps<{ book: BookDetail; triggerClass?: string }>(), {
  triggerClass: 'flex flex-1 items-center justify-center h-9 rounded-md border border-input bg-background text-sm hover:bg-muted transition-colors',
})

const { t } = useI18n()

const panel = reactive(useSyncChainPanel(() => props.book))

onMounted(() => {
  if (panel.isEligible) void panel.loadInitial()
})

const open = ref(false)
const triggerEl = ref<HTMLButtonElement | null>(null)

const readAlongRebuildRequested = ref(false)

function handleOpenChange(next: boolean) {
  open.value = next
  if (!next) {
    readAlongRebuildRequested.value = false
    return
  }
  // Measured before the content mounts, so the panel opens in its final view without a flash.
  const rect = triggerEl.value?.getBoundingClientRect()
  const availableHeight = rect ? availableHeightFromTrigger(rect, window.innerHeight) : window.innerHeight
  panel.prepareView(availableHeight, readAlongRebuildRequested.value ? 'modify' : undefined)
  void panel.handleOpen()
}

function handleReadAlongRebuildRequestHandled() {
  readAlongRebuildRequested.value = false
}

const canRequestReadAlongRebuild = computed(() => panel.canRequestReadAlongRebuild)

/** Opens the panel on its read-along rebuild confirm, for a rebuild offered elsewhere on the page. */
function requestReadAlongRebuild() {
  if (!canRequestReadAlongRebuild.value) return
  readAlongRebuildRequested.value = true
  if (!open.value) handleOpenChange(true)
}

defineExpose({ canRequestReadAlongRebuild, requestReadAlongRebuild })

// Opening keeps focus off the panel's first control, so a stray Enter right after opening changes nothing.
function handleOpenAutoFocus(event: Event) {
  event.preventDefault()
}
</script>

<template>
  <Popover v-if="panel.isEligible" :open="open" @update:open="handleOpenChange">
    <PopoverTrigger as-child>
      <button ref="triggerEl" type="button" :class="triggerClass" :title="panel.triggerTooltip" :aria-label="t('book.detail.editionLink.trigger')">
        <Link2 class="size-3.5" :class="panel.triggerIconClass" />
      </button>
    </PopoverTrigger>
    <PopoverContent
      align="end"
      :collision-padding="16"
      class="max-h-(--reka-popover-content-available-height) w-[22rem] max-w-[calc(100vw-2rem)] overflow-y-auto p-2 sm:w-[20rem]"
      @open-auto-focus="handleOpenAutoFocus"
    >
      <SyncChainPanel
        :panel="panel"
        :read-along-rebuild-requested="readAlongRebuildRequested"
        @read-along-rebuild-request-handled="handleReadAlongRebuildRequestHandled"
      />
    </PopoverContent>
  </Popover>
</template>

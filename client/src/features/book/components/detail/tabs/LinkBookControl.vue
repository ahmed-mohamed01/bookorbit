<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Link2 } from '@lucide/vue'
import type { BookDetail, CreateReadAloudJobRequest } from '@bookorbit/types'
import type { EditionProgress } from '@/features/book/components/detail/details/BookEditionsCard.vue'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useSyncChainPanel } from '@/features/book/composables/useSyncChainPanel'
import { availableHeightFromTrigger } from '@/features/book/lib/sync-chain'
import ReadAloudDialog from '@/features/read-aloud/components/ReadAloudDialog.vue'
import SyncChainPanel from './edition-link/SyncChainPanel.vue'

const props = withDefaults(defineProps<{ book: BookDetail; progress?: EditionProgress[]; triggerClass?: string }>(), {
  progress: () => [],
  triggerClass: 'flex flex-1 items-center justify-center h-9 rounded-md border border-input bg-background text-sm hover:bg-muted transition-colors',
})
const emit = defineEmits<{ saved: [BookDetail] }>()

const { t } = useI18n()

const open = ref(false)
const triggerEl = ref<HTMLButtonElement | null>(null)

const panel = reactive(
  useSyncChainPanel(() => props.book, {
    progress: () => props.progress,
    onSaved: (updated) => emit('saved', updated),
  }),
)

function handleCloseReadAloudDialog() {
  panel.closeReadAloudDialog()
}

function handleCreateReadAloud(input: CreateReadAloudJobRequest) {
  void panel.createReadAloudFromDialog(input)
}

onMounted(() => {
  void panel.loadInitial()
})

function handleOpenChange(next: boolean) {
  open.value = next
  if (!next) return
  // Measured before the content mounts, so the panel opens in its final view without a flash.
  const rect = triggerEl.value?.getBoundingClientRect()
  const availableHeight = rect ? availableHeightFromTrigger(rect, window.innerHeight) : window.innerHeight
  panel.prepareView(availableHeight)
  void panel.handleOpen()
}

// Opening keeps focus off the panel's first control, so a stray Enter right after opening changes nothing.
function handleOpenAutoFocus(event: Event) {
  event.preventDefault()
}
</script>

<template>
  <Popover v-if="panel.isEligible" :open="open" @update:open="handleOpenChange">
    <PopoverTrigger as-child>
      <button ref="triggerEl" type="button" :class="triggerClass" :title="panel.triggerTooltip" :aria-label="t('book.detail.readingAlignment.title')">
        <Link2 class="size-3.5" :class="panel.triggerIconClass" />
      </button>
    </PopoverTrigger>
    <PopoverContent
      align="end"
      :collision-padding="16"
      class="max-h-(--reka-popover-content-available-height) w-[22rem] max-w-[calc(100vw-2rem)] overflow-y-auto p-2 [view-transition-name:sync-chain-popover] sm:w-[20rem]"
      @open-auto-focus="handleOpenAutoFocus"
    >
      <SyncChainPanel :panel="panel" />
    </PopoverContent>
  </Popover>
  <!-- Outside the popover so the modal is neither clipped by it nor unmounted when it closes. -->
  <ReadAloudDialog
    v-if="panel.readAloudDialog.capability"
    :open="panel.readAloudDialog.open"
    :capability="panel.readAloudDialog.capability"
    :default-language="panel.readAloudDialog.defaultLanguage"
    :initial="null"
    :busy="panel.readAloudDialog.busy"
    :error="panel.readAloudDialog.error"
    @close="handleCloseReadAloudDialog"
    @create="handleCreateReadAloud"
  />
</template>

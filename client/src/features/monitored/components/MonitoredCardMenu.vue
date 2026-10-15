<script setup lang="ts">
import { BookOpen, Check, Download, Eye, Headphones, PanelRight, Trash2 } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

export interface CardFormatMenu {
  disabled: boolean
  label: string
  owned: boolean
  pending: boolean
}

defineProps<{
  canManage: boolean
  canQuickView: boolean
  ebook: CardFormatMenu
  audiobook: CardFormatMenu
}>()
const emit = defineEmits<{
  preview: []
  'quick-view': []
  'download-ebook': []
  'download-audiobook': []
  stop: []
}>()

const { t } = useI18n()

function handlePreview() {
  emit('preview')
}

function handleQuickView() {
  emit('quick-view')
}

function handleDownloadEbook() {
  emit('download-ebook')
}

function handleDownloadAudiobook() {
  emit('download-audiobook')
}

function handleStop() {
  emit('stop')
}
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <slot />
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" class="w-56">
      <DropdownMenuItem @click="handlePreview">
        <PanelRight />
        {{ t('monitored.detail.quickLook') }}
      </DropdownMenuItem>
      <DropdownMenuItem :disabled="!canQuickView" @click="handleQuickView">
        <Eye />
        {{ t('monitored.detail.quickView') }}
      </DropdownMenuItem>
      <template v-if="canManage">
        <DropdownMenuItem :disabled="ebook.disabled" @click="handleDownloadEbook">
          <BookOpen v-if="ebook.owned" />
          <Check v-else-if="ebook.pending" />
          <Download v-else />
          {{ ebook.label }}
        </DropdownMenuItem>
        <DropdownMenuItem :disabled="audiobook.disabled" @click="handleDownloadAudiobook">
          <Headphones v-if="audiobook.owned" />
          <Check v-else-if="audiobook.pending" />
          <Download v-else />
          {{ audiobook.label }}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" @click="handleStop">
          <Trash2 />
          {{ t('monitored.actions.stopMonitoring') }}
        </DropdownMenuItem>
      </template>
    </DropdownMenuContent>
  </DropdownMenu>
</template>

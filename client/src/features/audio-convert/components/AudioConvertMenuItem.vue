<script setup lang="ts">
// Fork: Convert to M4B entry in the book page's ⋮ menu. Opens the Files tab with the convert
// dialog showing, so the dialog and the job status live in one place. The caller gates it with
// useAudioConvertVisible's `offered`.
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { FileAudio } from '@lucide/vue'
import { AUDIO_CONVERT_OPEN_QUERY } from '../lib/audio-convert'

const emit = defineEmits<{ select: [] }>()

const { t } = useI18n()
const route = useRoute()
const router = useRouter()

function handleClick(): void {
  emit('select')
  void router.push({ query: { ...route.query, tab: 'files', [AUDIO_CONVERT_OPEN_QUERY]: '1' } })
}
</script>

<template>
  <button
    class="flex w-full items-center gap-2 px-2 py-1.5 text-start rounded-xs text-sm text-foreground hover:bg-muted transition-colors"
    data-testid="detail-convert-m4b"
    @click="handleClick"
  >
    <FileAudio class="size-3.5 shrink-0" aria-hidden="true" />
    {{ t('audioConvert.book.action') }}
  </button>
</template>

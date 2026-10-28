<script setup lang="ts">
import { computed } from 'vue'
import { Link2, Link2Off, Unlink, X } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import type { EditionLinkMatch } from '@bookorbit/types'

import { Button } from '@/components/ui/button'
import { actionsFor } from '../match-display'

const props = defineProps<{ match: EditionLinkMatch; busy: boolean }>()
const emit = defineEmits<{ link: [matchId: number]; dismiss: [matchId: number]; unlink: [matchId: number] }>()

const { t } = useI18n()
const actions = computed(() => actionsFor(props.match))

function handleLink(): void {
  emit('link', props.match.id)
}

function handleDismiss(): void {
  emit('dismiss', props.match.id)
}

function handleUnlink(): void {
  emit('unlink', props.match.id)
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-1.5">
    <Button v-if="actions.primary" size="sm" :disabled="busy" @click="handleLink">
      <Link2 aria-hidden="true" />
      {{ actions.primary === 'relink' ? t('tools.editionLinks.actions.relink') : t('tools.editionLinks.actions.link') }}
    </Button>
    <Button v-if="actions.canDismiss" variant="ghost" size="sm" :disabled="busy" @click="handleDismiss">
      <X aria-hidden="true" />
      {{ t('tools.editionLinks.actions.notTheSame') }}
    </Button>
    <Button v-if="actions.canUnlink" variant="ghost" size="sm" :disabled="busy" @click="handleUnlink">
      <Unlink v-if="actions.primary !== 'relink'" aria-hidden="true" />
      <Link2Off v-else aria-hidden="true" />
      {{ t('tools.editionLinks.actions.unlink') }}
    </Button>
  </div>
</template>

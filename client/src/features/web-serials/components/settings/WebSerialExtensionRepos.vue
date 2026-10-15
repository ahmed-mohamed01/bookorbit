<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2, Plus, Trash2 } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import { isRepoUrl } from '../../composables/useWebSerialExtensions'
import { useWebSerialExtensionsContext } from './extensionsContext'

const { t } = useI18n()
const state = useWebSerialExtensionsContext()
const { repos, reposLoading, reposError, repoBusy, addingRepo, repoActionError } = state

const draft = ref('')
const pendingRemoval = ref<string | null>(null)
const valid = computed(() => isRepoUrl(draft.value))
const showInvalid = computed(() => draft.value.trim() !== '' && !valid.value)

function handleInput(event: Event) {
  draft.value = (event.target as HTMLInputElement).value
}

async function handleAdd() {
  if (!valid.value) return
  if (await state.addRepo(draft.value)) draft.value = ''
}

function handleRemove(url: string) {
  pendingRemoval.value = url
}

async function handleConfirmRemove() {
  const url = pendingRemoval.value
  if (!url) return
  await state.removeRepo(url)
  pendingRemoval.value = null
}

function handleCancelRemove() {
  pendingRemoval.value = null
}
</script>

<template>
  <div class="space-y-4">
    <div v-if="reposLoading && repos.length === 0" class="flex justify-center py-6">
      <Loader2 class="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
      <span class="sr-only">{{ t('webSerials.settings.extensions.loading') }}</span>
    </div>
    <p v-else-if="reposError" role="alert" class="text-xs text-destructive">{{ reposError }}</p>
    <p v-else-if="repos.length === 0" class="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
      {{ t('webSerials.settings.extensions.reposEmpty') }}
    </p>
    <ul v-else class="divide-y divide-border">
      <li v-for="repo in repos" :key="repo" class="flex items-center gap-3 py-2.5">
        <span class="min-w-0 flex-1 break-all font-mono text-xs text-foreground">{{ repo }}</span>
        <Button size="sm" variant="outline" class="text-destructive hover:text-destructive" :disabled="repoBusy !== null" @click="handleRemove(repo)">
          <Trash2 :size="14" aria-hidden="true" />
          {{ t('webSerials.settings.extensions.removeRepo') }}
        </Button>
      </li>
    </ul>

    <form class="space-y-1.5" @submit.prevent="handleAdd">
      <label for="web-serials-repo-url" class="settings-label">{{ t('webSerials.settings.extensions.addRepoLabel') }}</label>
      <div class="flex gap-2">
        <input
          id="web-serials-repo-url"
          :value="draft"
          type="url"
          inputmode="url"
          autocomplete="off"
          :aria-invalid="showInvalid"
          :placeholder="t('webSerials.settings.extensions.addRepoPlaceholder')"
          class="settings-control min-w-0 flex-1 font-mono"
          @input="handleInput"
        />
        <Button size="sm" type="submit" :disabled="!valid || addingRepo">
          <Loader2 v-if="addingRepo" class="animate-spin" aria-hidden="true" />
          <Plus v-else :size="14" aria-hidden="true" />
          {{ t('webSerials.settings.extensions.addRepo') }}
        </Button>
      </div>
      <p v-if="showInvalid" role="alert" class="text-xs text-destructive">{{ t('webSerials.settings.extensions.repoInvalid') }}</p>
      <p v-if="repoActionError" role="alert" class="text-xs text-destructive">{{ repoActionError }}</p>
    </form>

    <p class="settings-hint">{{ t('webSerials.settings.extensions.repoNote') }}</p>

    <ConfirmDialog
      :open="pendingRemoval !== null"
      :title="t('webSerials.settings.extensions.removeRepoTitle')"
      :description="t('webSerials.settings.extensions.removeRepoDescription', { url: pendingRemoval ?? '' })"
      :confirm-label="t('webSerials.settings.extensions.removeRepo')"
      :busy="repoBusy !== null"
      @confirm="handleConfirmRemove"
      @cancel="handleCancelRemove"
    />
  </div>
</template>

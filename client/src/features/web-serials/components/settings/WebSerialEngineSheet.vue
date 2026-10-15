<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { AlertCircle, CheckCircle2, Eye, EyeOff, Loader2, Plug } from '@lucide/vue'
import type { WebSerialKind } from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import ConnectionHealth from '@/features/settings/ConnectionHealth.vue'
import SettingsEditorSheet from '@/features/settings/components/SettingsEditorSheet.vue'
import SettingsField from '@/features/settings/components/SettingsField.vue'
import { SECRET_INPUT_ATTRS } from '@/lib/secret-input'
import { useWebSerialSettingsContext } from './settingsContext'

const props = defineProps<{ kind: WebSerialKind | null }>()
const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const state = useWebSerialSettingsContext()
const { settings, draft, saving, testing, testResults, testError, passwordWillBeCleared } = state

const revealed = ref(false)
const open = computed(() => props.kind !== null)
const engine = computed(() => (props.kind ? draft[props.kind] : null))
const stored = computed(() => (props.kind ? (settings.value?.[props.kind] ?? null) : null))
const health = computed(() => (props.kind ? testResults.value[props.kind] : null))
const error = computed(() => (props.kind ? testError.value[props.kind] : null))
const isTesting = computed(() => (props.kind ? testing.value[props.kind] : false))
const clearsPassword = computed(() => (props.kind ? passwordWillBeCleared.value[props.kind] : false))
const dirty = computed(() => (props.kind ? state.connectionDirty.value[props.kind] : false))
const canTest = computed(() => Boolean(engine.value?.url.trim()) && !isTesting.value)
const title = computed(() => (props.kind ? t(`webSerials.settings.sheet.${props.kind}.title`) : ''))
const isLnreader = computed(() => props.kind === 'novel' && draft.novel.engine === 'lnreader')
const passwordPlaceholder = computed(() => {
  if (clearsPassword.value) return t('webSerials.settings.sheet.passwordNewServer')
  return stored.value?.passwordConfigured ? t('webSerials.settings.sheet.passwordKeep') : t('webSerials.settings.sheet.passwordUnset')
})

watch(open, () => {
  revealed.value = false
})

function togglePassword() {
  revealed.value = !revealed.value
}

function handleNovelEngineChange(event: Event) {
  const value = (event.target as HTMLSelectElement).value
  if (value !== 'lnreader' && value !== 'lncrawl') return
  if (draft.novel.engine === value) return
  draft.novel.engine = value
  draft.novel.url = ''
  draft.novel.username = ''
  draft.novel.password = ''
}

function handleTest() {
  if (props.kind) void state.test(props.kind)
}

async function handleSave() {
  if (!props.kind) return
  if (clearsPassword.value) {
    toast.error(t('webSerials.settings.sheet.blockedByPassword'))
    return
  }
  if (!dirty.value) {
    emit('close')
    return
  }
  const kind = props.kind
  if (await state.saveConnection(kind)) {
    toast.success(t('webSerials.settings.saved'))
    emit('close')
  } else {
    toast.error(state.saveError.value ?? t('webSerials.settings.saveFailed'))
  }
}

function handleCancel() {
  if (props.kind) state.resetConnection(props.kind)
  emit('close')
}
</script>

<template>
  <SettingsEditorSheet
    :open="open"
    :title="title"
    :description="t('webSerials.settings.sheet.description')"
    :dirty="dirty"
    :busy="saving"
    @save="handleSave"
    @cancel="handleCancel"
  >
    <template #status>
      <ConnectionHealth :last-tested-at="health?.checkedAt ?? null" :last-test-ok="health?.ok ?? null" :enabled="Boolean(stored?.url)" />
    </template>

    <template v-if="engine && kind">
      <SettingsField v-if="kind === 'novel'" :label="t('webSerials.settings.sheet.novel.engineLabel')" input-id="web-serials-novel-engine">
        <select id="web-serials-novel-engine" class="settings-control" :value="draft.novel.engine" @change="handleNovelEngineChange">
          <option value="lnreader">{{ t('webSerials.settings.card.novel.engines.lnreader') }}</option>
          <option value="lncrawl">{{ t('webSerials.settings.card.novel.engines.lncrawl') }}</option>
        </select>
      </SettingsField>

      <SettingsField :label="t('webSerials.settings.sheet.url')" :input-id="`web-serials-${kind}-url`">
        <template #default="{ describedBy }">
          <input
            :id="`web-serials-${kind}-url`"
            v-model="engine.url"
            type="url"
            inputmode="url"
            autocomplete="url"
            :aria-describedby="describedBy"
            :placeholder="
              kind === 'novel'
                ? t(`webSerials.settings.sheet.novel.urlPlaceholder.${draft.novel.engine}`)
                : t('webSerials.settings.sheet.manga.urlPlaceholder')
            "
            class="settings-control"
          />
        </template>
      </SettingsField>

      <SettingsField v-if="!isLnreader" :label="t('webSerials.settings.sheet.username')" :input-id="`web-serials-${kind}-username`">
        <input :id="`web-serials-${kind}-username`" v-model="engine.username" type="text" autocomplete="username" class="settings-control" />
      </SettingsField>

      <SettingsField
        :label="isLnreader ? t('webSerials.settings.sheet.token') : t('webSerials.settings.sheet.password')"
        :input-id="`web-serials-${kind}-password`"
      >
        <div class="flex gap-2">
          <input
            :id="`web-serials-${kind}-password`"
            v-model="engine.password"
            v-bind="SECRET_INPUT_ATTRS"
            type="text"
            :class="{ 'input-secret': !revealed }"
            :placeholder="passwordPlaceholder"
            class="settings-control min-w-0 flex-1"
          />
          <Button
            size="icon"
            variant="outline"
            type="button"
            :aria-label="revealed ? t('webSerials.settings.sheet.hidePassword') : t('webSerials.settings.sheet.showPassword')"
            @click="togglePassword"
          >
            <EyeOff v-if="revealed" :size="16" aria-hidden="true" />
            <Eye v-else :size="16" aria-hidden="true" />
          </Button>
        </div>
        <p v-if="clearsPassword" class="mt-1.5 flex items-start gap-1 text-xs text-destructive">
          <AlertCircle class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {{ t('webSerials.settings.sheet.clearedOnServerChange') }}
        </p>
        <p v-else-if="stored?.passwordConfigured" class="mt-1.5 flex items-center gap-1 text-xs text-primary">
          <CheckCircle2 class="size-3.5" aria-hidden="true" />
          {{ t('webSerials.settings.sheet.passwordSaved') }}
        </p>
      </SettingsField>

      <div class="flex flex-wrap items-center gap-3">
        <Button size="sm" variant="outline" type="button" :disabled="!canTest" @click="handleTest">
          <Loader2 v-if="isTesting" class="animate-spin" aria-hidden="true" />
          <Plug v-else :size="14" aria-hidden="true" />
          {{ isTesting ? t('webSerials.settings.sheet.testing') : t('webSerials.settings.card.test') }}
        </Button>
        <p v-if="error" role="alert" class="flex items-center gap-1.5 text-xs text-destructive">
          <AlertCircle class="size-3.5 shrink-0" aria-hidden="true" />
          {{ error }}
        </p>
        <p v-else-if="health?.ok" role="status" class="flex items-center gap-1.5 text-xs text-muted-foreground">
          <CheckCircle2 class="size-3.5 text-success" aria-hidden="true" />
          {{ t(`webSerials.settings.card.sources.${kind}`, { count: health.searchableSources }) }}
        </p>
        <p v-else-if="health" role="alert" class="flex items-center gap-1.5 text-xs text-destructive">
          <AlertCircle class="size-3.5 shrink-0" aria-hidden="true" />
          {{ health.error ?? t('webSerials.settings.sheet.testFailed') }}
        </p>
      </div>
    </template>
  </SettingsEditorSheet>
</template>

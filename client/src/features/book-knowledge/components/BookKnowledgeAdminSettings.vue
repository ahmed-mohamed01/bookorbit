<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Permission } from '@bookorbit/types'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import { Button } from '@/components/ui/button'
import { useBookKnowledgeSettings } from '../composables/useBookKnowledgeSettings'
const { t } = useI18n()
const { hasPermission } = usePermissions()
const allowed = computed(() => hasPermission(Permission.ManageAppSettings))
const { settings, busy, failed, saved, load, save } = useBookKnowledgeSettings(() => allowed.value)
</script>
<template>
  <section v-if="allowed" class="space-y-4 rounded-xl border border-border bg-card p-5 text-card-foreground">
    <h2 class="text-lg font-semibold">{{ t('bookKnowledge.title') }}</h2>
    <p v-if="busy" role="status">{{ t('bookKnowledge.loading') }}</p>
    <div v-if="failed" role="alert">
      <p>{{ t('bookKnowledge.request') }}</p>
      <Button variant="outline" :disabled="busy" @click="load">{{ t('bookKnowledge.retry') }}</Button>
    </div>
    <p v-if="saved" role="status">{{ t('bookKnowledge.saved') }}</p>
    <form v-if="settings" class="space-y-4" @submit.prevent="save">
      <label class="flex items-center gap-2 text-sm"><input v-model="settings.enabled" type="checkbox" />{{ t('bookKnowledge.enabled') }}</label>
      <p class="text-sm text-muted-foreground">{{ t('bookKnowledge.modelHint') }}</p>
      <Button type="submit" :disabled="busy">{{ t('bookKnowledge.save') }}</Button>
    </form>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Permission } from '@bookorbit/types'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import EditionSyncAdminSettings from '@/features/edition-sync/components/EditionSyncAdminSettings.vue'
import EditionSyncBooksList from '@/features/edition-sync/components/EditionSyncBooksList.vue'
import EditionSyncIndexingCard from '@/features/edition-sync/components/EditionSyncIndexingCard.vue'
import EditionSyncSettings from '@/features/edition-sync/components/EditionSyncSettings.vue'
import { provideEditionSyncAdmin } from '@/features/edition-sync/composables/useEditionSyncAdmin'
import { useEditionSyncSettings } from '@/features/edition-sync/composables/useEditionSyncSettings'

const { t } = useI18n()
const { hasPermission } = usePermissions()
const { settings } = useEditionSyncSettings()
const admin = provideEditionSyncAdmin()
const { runActive } = admin

const booksList = ref<InstanceType<typeof EditionSyncBooksList> | null>(null)

const canUseEditionSync = computed(() => hasPermission(Permission.EditionSync))
const canAdminEditionSync = computed(() => hasPermission(Permission.ManageAppSettings))
const hasAnySection = computed(() => canUseEditionSync.value || canAdminEditionSync.value)
const showBooks = computed(() => {
  const reason = settings.value?.disabledReason
  return canUseEditionSync.value && !!settings.value && reason !== 'server_disabled' && reason !== 'permission_denied'
})

onMounted(() => {
  if (canAdminEditionSync.value) void admin.load()
})

function handleSettingsSaved() {
  void booksList.value?.load()
}
</script>

<template>
  <div class="space-y-8">
    <p v-if="!hasAnySection" class="text-sm text-muted-foreground">{{ t('editionSync.fork.empty') }}</p>

    <section v-if="canUseEditionSync" class="space-y-3" aria-labelledby="fork-edition-sync-user">
      <h3 id="fork-edition-sync-user" class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
        {{ t('editionSync.fork.userHeading') }}
      </h3>
      <EditionSyncSettings @saved="handleSettingsSaved" />
    </section>

    <section v-if="canAdminEditionSync" class="space-y-3" aria-labelledby="fork-edition-sync-admin">
      <h3 id="fork-edition-sync-admin" class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
        {{ t('editionSync.fork.adminHeading') }}
      </h3>
      <EditionSyncAdminSettings />
    </section>

    <EditionSyncIndexingCard v-if="canAdminEditionSync" />

    <EditionSyncBooksList v-if="showBooks" ref="booksList" :run-active="runActive" />
  </div>
</template>

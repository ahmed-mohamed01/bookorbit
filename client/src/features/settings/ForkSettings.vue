<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Permission } from '@bookorbit/types'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import EditionSyncAdminSection from '@/features/edition-sync/components/EditionSyncAdminSection.vue'
import EditionSyncSettings from '@/features/edition-sync/components/EditionSyncSettings.vue'

const { t } = useI18n()
const { hasPermission } = usePermissions()

const canUseEditionSync = computed(() => hasPermission(Permission.EditionSync))
const canAdminEditionSync = computed(() => hasPermission(Permission.ManageAppSettings))
const hasAnySection = computed(() => canUseEditionSync.value || canAdminEditionSync.value)
</script>

<template>
  <div class="space-y-8">
    <p v-if="!hasAnySection" class="text-sm text-muted-foreground">{{ t('editionSync.fork.empty') }}</p>

    <section v-if="canUseEditionSync" class="space-y-3" aria-labelledby="fork-edition-sync-user">
      <h3 id="fork-edition-sync-user" class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
        {{ t('editionSync.fork.userHeading') }}
      </h3>
      <EditionSyncSettings />
    </section>

    <section v-if="canAdminEditionSync" class="space-y-3" aria-labelledby="fork-edition-sync-admin">
      <h3 id="fork-edition-sync-admin" class="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
        {{ t('editionSync.fork.adminHeading') }}
      </h3>
      <EditionSyncAdminSection />
    </section>
  </div>
</template>

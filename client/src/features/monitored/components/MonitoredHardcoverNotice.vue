<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowUpRight, TriangleAlert } from '@lucide/vue'
import { Permission } from '@bookorbit/types'
import { usePermissions } from '@/features/auth/composables/usePermissions'

const { t } = useI18n()
const { hasPermission } = usePermissions()
const canConnect = computed(() => hasPermission(Permission.HardcoverSync))
const canFixProviders = computed(() => hasPermission(Permission.ManageMetadataConfig))
const message = computed(() =>
  t(
    canConnect.value
      ? 'monitored.hardcoverNotice.connect'
      : canFixProviders.value
        ? 'monitored.hardcoverNotice.hint'
        : 'monitored.hardcoverNotice.askAdmin',
  ),
)
const linkTarget = computed(() =>
  canConnect.value ? { name: 'settings-hardcover' } : canFixProviders.value ? { name: 'settings-metadata-providers' } : null,
)
const linkLabel = computed(() => t(canConnect.value ? 'monitored.hardcoverNotice.connectHardcover' : 'monitored.hardcoverNotice.openSettings'))
</script>

<template>
  <div role="status" class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-warning/40 bg-warning/10 px-3.5 py-3 text-sm">
    <TriangleAlert :size="16" class="shrink-0 text-warning" aria-hidden="true" />
    <p class="min-w-56 flex-1 text-foreground">
      <span class="font-medium">{{ t('monitored.hardcoverNotice.title') }}</span>
      <span class="text-muted-foreground"> {{ message }}</span>
    </p>
    <RouterLink
      v-if="linkTarget"
      :to="linkTarget"
      class="inline-flex shrink-0 items-center gap-0.5 font-medium text-foreground underline-offset-2 hover:underline"
    >
      {{ linkLabel }}
      <ArrowUpRight :size="14" aria-hidden="true" />
    </RouterLink>
  </div>
</template>

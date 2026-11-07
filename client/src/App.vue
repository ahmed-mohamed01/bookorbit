<script setup lang="ts">
import { defineAsyncComponent, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useChangePasswordDialog } from '@/composables/useChangePasswordDialog'
import { useWhatsNew } from '@/features/whats-new/composables/useWhatsNew'
import { useAuth } from '@/features/auth/composables/useAuth'
import { useSessionBootstrap } from '@/features/auth/composables/useSessionBootstrap'
import TtsMiniPlayer from '@/features/tts/components/TtsMiniPlayer.vue'
import MediaOverlayDock from '@/features/reader/media-overlay/components/MediaOverlayDock.vue'
import { useMediaOverlay } from '@/features/reader/media-overlay/composables/useMediaOverlay'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { resolveRouteViewKey } from '@/router/view-key'
import LegalNotices from '@/components/legal/LegalNotices.vue'
import ServerReconnectScreen from '@/features/auth/components/ServerReconnectScreen.vue'

const ChangePasswordDialog = defineAsyncComponent(() => import('@/features/auth/ChangePasswordDialog.vue'))
const WhatsNewDialog = defineAsyncComponent(() => import('@/features/whats-new/WhatsNewDialog.vue'))

// The bottom-edge TTS player publishes its measured height, so the toaster clears it.
const TOASTER_OFFSET = {
  right: '16px',
  bottom: 'max(16px, var(--tts-mini-player-clearance, 0px), var(--narration-dock-right-clearance, 0px))',
}
const TOASTER_MOBILE_OFFSET = {
  left: '16px',
  right: '16px',
  bottom: 'max(16px, var(--tts-mini-player-clearance, 0px), var(--narration-dock-clearance, 0px))',
}

const { isOpen } = useChangePasswordDialog()

const route = useRoute()
const { user } = useAuth()
const { unreachable: serverUnreachable } = useSessionBootstrap()
const { popupOpen, evaluate, syncPopup } = useWhatsNew()
const narration = useMediaOverlay()

watch(
  () => user.value,
  async (current, previous) => {
    // Narration can outlive its reader, so it must not carry on into another session.
    if (previous && (!current || current.id !== previous.id)) narration.stop()
    if (!current) return
    narration.restoreBackground(current.id)
    await evaluate()
    syncPopup(route.name as string | undefined)
  },
  { immediate: true },
)

watch(
  () => route.name,
  (name) => syncPopup(name as string | undefined),
)
</script>

<template>
  <TooltipProvider :delay-duration="0">
    <ServerReconnectScreen v-if="serverUnreachable" />
    <router-view v-slot="{ Component, route: activeRoute }">
      <Transition name="page" mode="out-in">
        <component :is="Component" :key="resolveRouteViewKey(activeRoute)" />
      </Transition>
    </router-view>
    <ChangePasswordDialog v-if="isOpen" />
    <WhatsNewDialog v-if="popupOpen" />
    <LegalNotices />
    <TtsMiniPlayer />
    <MediaOverlayDock />
    <Toaster rich-colors position="bottom-right" :visible-toasts="5" :gap="8" :offset="TOASTER_OFFSET" :mobile-offset="TOASTER_MOBILE_OFFSET" />
  </TooltipProvider>
</template>

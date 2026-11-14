import type { RouteRecordRaw } from 'vue-router'
import { Permission } from '@bookorbit/types'
import { i18n } from '@/i18n'

const t = i18n.global.t

export const forkIntegrationRoutes: RouteRecordRaw[] = [
  // Fork: Convert to M4B.
  {
    path: 'audio-conversion',
    name: 'settings-audio-convert',
    component: () => import('@/features/audio-convert/components/AudioConvertSettingsSection.vue'),
    meta: { maxWidth: 'max-w-3xl', title: () => t('audioConvert.settings.heading'), requiredPermission: Permission.ManageAppSettings },
  },
  {
    path: 'fork',
    name: 'settings-fork',
    component: () => import('@/features/settings/ForkSettings.vue'),
    meta: { maxWidth: 'max-w-3xl', title: () => t('editionSync.fork.title') },
  },
]

export const forkAudiobookshelfRoutes: RouteRecordRaw[] = [
  {
    path: 'audiobookshelf',
    name: 'settings-audiobookshelf',
    component: () => import('@/features/audiobookshelf/components/AudiobookshelfSettings.vue'),
    props: { embedded: true },
    meta: { maxWidth: 'max-w-3xl', title: () => t('settings.integrations.tabs.audiobookshelf') },
  },
]

export const forkMonitoredSettingsRoutes: RouteRecordRaw[] = [
  {
    path: 'admin/monitored',
    name: 'settings-admin-monitored',
    component: () => import('@/features/settings/MonitoredSettings.vue'),
    props: { embedded: true },
    meta: { maxWidth: 'max-w-3xl', title: () => t('titles.system.monitored') },
  },
]

export const forkWebSerialSettingsRoutes: RouteRecordRaw[] = [
  {
    path: 'admin/web-serials',
    name: 'settings-admin-web-serials',
    component: () => import('@/features/web-serials/components/WebSerialsSettings.vue'),
    props: { embedded: true },
    meta: {
      maxWidth: 'max-w-3xl',
      requiredPermission: Permission.ManageAppSettings,
      permissionFallback: 'settings-account-profile',
      title: () => t('webSerials.admin.title'),
    },
  },
]

export const forkLibraryRoutes: RouteRecordRaw[] = [
  {
    path: '/monitored',
    redirect: (to) => ({ path: '/watchlist', query: to.query, hash: to.hash }),
  },
  {
    path: '/monitored/authors/:id',
    redirect: (to) => ({ path: `/watchlist/authors/${String(to.params.id)}`, query: to.query, hash: to.hash }),
  },
  {
    path: '/watchlist',
    name: 'monitored',
    component: () => import('@/features/monitored/views/MonitoredView.vue'),
    meta: { title: () => t('titles.monitored') },
  },
  {
    path: '/watchlist/authors/:id',
    name: 'monitored-author',
    component: () => import('@/features/monitored/views/MonitoredAuthorDetailView.vue'),
    meta: { title: () => t('titles.monitoredAuthor') },
  },
  {
    path: '/web-serials',
    name: 'web-serials',
    component: () => import('@/features/web-serials/WebSerialsPage.vue'),
    meta: { requiredPermission: Permission.WebSerialAccess, title: () => t('titles.webSerials') },
  },
  {
    path: '/web-serials/queue',
    name: 'web-serials-queue',
    redirect: { name: 'web-serials', query: { tab: 'queue' } },
  },
]

export const forkToolRoutes: RouteRecordRaw[] = [
  // Fork: Convert to M4B.
  {
    path: 'convert-m4b',
    name: 'tools-convert-m4b',
    component: () => import('@/features/audio-convert/views/AudioConvertView.vue'),
    meta: { title: () => t('audioConvert.tool.title') },
  },
]

import { FileAudio, GitFork, Headphones, RefreshCw, Globe } from '@lucide/vue'
import { Permission } from '@bookorbit/types'
import type { SettingsNavItem } from './settings-nav'

export const forkLibrarySettingsNav: SettingsNavItem[] = [
  // Fork: Convert to M4B.
  {
    id: 'audio-conversion',
    routeName: 'settings-audio-convert',
    labelKey: 'audioConvert.settings.heading',
    descriptionKey: 'audioConvert.settings.navDescription',
    icon: FileAudio,
    keywords: 'audio conversion convert m4b mp3 merge chapters encode aac backup',
    isVisible: (context) => context.isSuperuser || context.permissions.includes(Permission.ManageAppSettings),
  },
]

export const forkAccountSettingsNav: SettingsNavItem[] = [
  {
    id: 'fork-settings',
    routeName: 'settings-fork',
    labelKey: 'editionSync.fork.title',
    descriptionKey: 'editionSync.fork.description',
    icon: GitFork,
    keywords: 'fork edition sync read aloud timing index whisper audiobook ebook position schedule worker queue failed retry',
    isVisible: (context) =>
      context.isSuperuser || [Permission.EditionSync, Permission.ManageAppSettings].some((permission) => context.permissions.includes(permission)),
  },
]

export const forkIntegrationSettingsNav: SettingsNavItem[] = [
  {
    id: 'audiobookshelf',
    routeName: 'settings-audiobookshelf',
    labelKey: 'settings.integrations.tabs.audiobookshelf',
    descriptionKey: 'settings.integrations.providerSubtitles.audiobookshelf',
    icon: Headphones,
    keywords: 'audiobookshelf audiobook sync listening progress sessions',
    isVisible: (context) => context.isSuperuser || context.permissions.includes(Permission.AudiobookshelfSync),
  },
]

export const forkMonitoredSettingsNav: SettingsNavItem[] = [
  {
    id: 'monitored',
    routeName: 'settings-admin-monitored',
    labelKey: 'settings.system.tabs.monitored',
    descriptionKey: 'settings.nav.descriptions.monitored',
    icon: RefreshCw,
    keywords: 'monitored watchlist authors refresh cooldown provider throttle',
    isVisible: (context) => context.isSuperuser || context.permissions.includes(Permission.ManageAppSettings),
  },
]

export const forkWebSerialSettingsNav: SettingsNavItem[] = [
  {
    id: 'web-serials',
    routeName: 'settings-admin-web-serials',
    labelKey: 'webSerials.admin.title',
    descriptionKey: 'settings.nav.descriptions.webSerials',
    icon: Globe,
    keywords: 'web serials manga novel suwayomi lightnovel crawler lncrawl chapters volumes download',
    isVisible: (context) => context.isSuperuser || context.permissions.includes(Permission.ManageAppSettings),
  },
]

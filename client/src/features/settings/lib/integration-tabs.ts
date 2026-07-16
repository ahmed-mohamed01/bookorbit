import { Permission } from '@bookorbit/types'

export const INTEGRATION_TABS = ['hardcover', 'readwise', 'storygraph', 'audiobookshelf'] as const

export type IntegrationTab = (typeof INTEGRATION_TABS)[number]

type IntegrationTabInfo = {
  navLabel: string
  titleLabel: string
  permission: Permission
}

// Resolves to Permission.AudiobookshelfSync when the parallel shared-types change lands.
const AUDIOBOOKSHELF_PERMISSION = 'audiobookshelf_sync' as Permission

export const INTEGRATION_TAB_INFO: Record<IntegrationTab, IntegrationTabInfo> = {
  hardcover: {
    navLabel: 'Hardcover',
    titleLabel: 'Hardcover',
    permission: Permission.HardcoverSync,
  },
  readwise: {
    navLabel: 'Readwise',
    titleLabel: 'Readwise',
    permission: Permission.ReadwiseSync,
  },
  storygraph: {
    navLabel: 'StoryGraph',
    titleLabel: 'StoryGraph',
    permission: Permission.StorygraphSync,
  },
  audiobookshelf: {
    navLabel: 'Audiobookshelf',
    titleLabel: 'Audiobookshelf',
    permission: AUDIOBOOKSHELF_PERMISSION,
  },
}

export function normalizeIntegrationTab(value: unknown): IntegrationTab {
  if (typeof value === 'string' && INTEGRATION_TABS.includes(value as IntegrationTab)) {
    return value as IntegrationTab
  }
  return 'hardcover'
}

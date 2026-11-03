import {
  AudioLines,
  Bell,
  BookPlus,
  FileCog,
  FolderSync,
  Globe,
  HardDriveDownload,
  Mail,
  RefreshCw,
  ScanLine,
  Tags,
  Trophy,
  Users,
  type LucideIcon,
} from '@lucide/vue'
import type { NotificationCategory } from '@bookorbit/types'

export const NOTIFICATION_CATEGORY_GROUPS = [
  { id: 'library', categories: ['scanning', 'metadata', 'authorEnrichment'] },
  { id: 'files', categories: ['fileWriteBack', 'fileRename', 'bulkRename', 'readAloud', 'migration'] },
  { id: 'integrations', categories: ['bookDock', 'bookRequests', 'monitored', 'webSerials', 'email'] },
  { id: 'personal', categories: ['achievements'] },
] as const satisfies ReadonlyArray<{ id: string; categories: readonly NotificationCategory[] }>

export const NOTIFICATION_CATEGORY_ICONS: Record<NotificationCategory, LucideIcon> = {
  scanning: ScanLine,
  metadata: Tags,
  authorEnrichment: Users,
  fileWriteBack: HardDriveDownload,
  fileRename: FileCog,
  bulkRename: FileCog,
  migration: RefreshCw,
  bookDock: FolderSync,
  bookRequests: BookPlus,
  monitored: Bell,
  webSerials: Globe,
  email: Mail,
  readAloud: AudioLines,
  achievements: Trophy,
}

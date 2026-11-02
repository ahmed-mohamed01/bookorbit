/** A one-line sync status on the book page, already translated, with an optional problem behind an icon. */

export type SyncStatusTone = 'success' | 'info' | 'warning' | 'destructive' | 'muted'
export type SyncIssueTone = 'warning' | 'destructive' | 'info'
export type SyncIssueIcon = 'alert' | 'clock'

export interface SyncIssueAction<Id extends string = string> {
  id: Id
  label: string
  disabled?: boolean
  /** The dropdown stays open after it, such as Change match swapping in the search. */
  keepOpen?: boolean
}

export interface SyncIssue<Id extends string = string> {
  tone: SyncIssueTone
  icon: SyncIssueIcon
  /** The dropdown's bold title; also the icon button's accessible name. */
  title: string
  detail: string | null
  actions: SyncIssueAction<Id>[]
}

export interface SyncStatus<Id extends string = string> {
  text: string
  tone: SyncStatusTone
  spinner: boolean
  issue: SyncIssue<Id> | null
}

export type Translate = (key: string, params?: Record<string, unknown>) => string

// Healthy and in-progress states read as plain secondary text, like the other Details rows; only problems take a colour.
export const SYNC_STATUS_TEXT_CLASS: Record<SyncStatusTone, string> = {
  success: 'text-muted-foreground',
  info: 'text-muted-foreground',
  warning: 'text-warning',
  destructive: 'text-destructive',
  muted: 'text-muted-foreground',
}

export function syncStatus<Id extends string = string>(
  text: string,
  tone: SyncStatusTone,
  issue: SyncIssue<Id> | null = null,
  spinner = false,
): SyncStatus<Id> {
  return { text, tone, spinner, issue }
}

export function syncIssue<Id extends string = string>(
  spec: Omit<SyncIssue<Id>, 'actions' | 'detail'> & { detail?: string | null; actions?: SyncIssueAction<Id>[] },
): SyncIssue<Id> {
  return { ...spec, detail: spec.detail ?? null, actions: spec.actions ?? [] }
}

/** A 0..100 progress value as a whole percent; null stays null. */
export function clampPercent(progress: number | null): number | null {
  return progress === null ? null : Math.round(Math.min(Math.max(progress, 0), 100))
}

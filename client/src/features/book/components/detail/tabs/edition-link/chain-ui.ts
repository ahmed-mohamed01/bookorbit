import type { Component } from 'vue'
import { Ban, CloudDownload, CloudUpload, Link2, Loader2, RefreshCw, TriangleAlert } from '@lucide/vue'
import type { ChainActionId, ChainFrame, ChainIcon, ChainTone } from '@/features/book/lib/sync-chain'
import { viewTransitionName } from '@/features/book/lib/sync-chain-view'

export const CHAIN_ICON: Record<ChainIcon, Component> = { link: Link2, spinner: Loader2, alert: TriangleAlert, ban: Ban }
export const CHAIN_ICON_MOTION: Record<ChainIcon, string> = { link: '', spinner: 'animate-spin', alert: '', ban: '' }

export const ABS_SETTINGS_ROUTE = { name: 'settings-audiobookshelf' }

/** Only the Audiobookshelf reconcile actions carry a glyph: it shows which way the position travels. */
export const CHAIN_ACTION_ICON: Partial<Record<ChainActionId, Component>> = { absPush: CloudUpload, absPull: CloudDownload, retryAbs: RefreshCw }

export const CHAIN_SWITCH_TRACK_CLASS: Record<ChainTone, string> = {
  success: 'bg-success',
  info: 'bg-info',
  warning: 'bg-warning',
  destructive: 'bg-destructive',
  muted: 'bg-muted',
}

export const CHAIN_NODE_CLASS: Record<ChainTone, string> = {
  success: 'border-success bg-success/15 text-success',
  info: 'border-info bg-info/15 text-info',
  warning: 'border-warning bg-warning/15 text-warning',
  destructive: 'border-destructive bg-destructive/10 text-destructive',
  muted: 'border-border bg-card text-muted-foreground',
}

export const CHAIN_TONE_TEXT_CLASS: Record<ChainTone, string> = {
  success: 'text-success',
  info: 'text-info',
  warning: 'text-warning',
  destructive: 'text-destructive',
  muted: 'text-muted-foreground',
}

type ChainChrome = 'plain' | 'dashed' | 'dashedFilled'

const CHAIN_CHROME_CLASS: Record<ChainChrome, string> = {
  plain: 'rounded-xl border border-border bg-card',
  dashed: 'rounded-xl border border-dashed border-border bg-transparent',
  dashedFilled: 'rounded-xl border border-dashed border-border bg-card',
}

/** Rows inside the audio group box drop their own chrome: the box carries it for them. */
export function frameChromeClass(frame: ChainFrame, chrome: ChainChrome): string {
  return frame === 'group' ? '' : CHAIN_CHROME_CLASS[chrome]
}

export function chainRowStyle(id: string): { viewTransitionName: string } {
  return { viewTransitionName: viewTransitionName(id) }
}

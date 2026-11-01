import type { EditionSyncBookState, ReadAloudProgressSyncMode } from '@bookorbit/types'

export type EditionSyncToggleKind = 'readAlong' | 'index' | 'none'

export interface EditionSyncTogglePlan {
  setIndexOverride: boolean
  setReadAloudMode: ReadAloudProgressSyncMode | null
}

export function editionSyncToggleKind(state: EditionSyncBookState | null): EditionSyncToggleKind {
  if (!state) return 'none'
  if (state.hasReadAlong && state.hasAudio) return 'readAlong'
  return state.eligible ? 'index' : 'none'
}

export function editionSyncToggleValue(
  kind: EditionSyncToggleKind,
  state: EditionSyncBookState | null,
  readAloudMode: ReadAloudProgressSyncMode,
): boolean {
  if (kind === 'readAlong') return readAloudMode === 'auto'
  return state?.syncEnabled === true && readAloudMode !== 'disabled'
}

export function planEditionSyncToggle(kind: EditionSyncToggleKind, value: boolean, readAloudMode: ReadAloudProgressSyncMode): EditionSyncTogglePlan {
  if (kind === 'readAlong') return { setIndexOverride: false, setReadAloudMode: value ? 'auto' : 'disabled' }
  if (kind === 'index') return { setIndexOverride: true, setReadAloudMode: value && readAloudMode === 'disabled' ? 'auto' : null }
  return { setIndexOverride: false, setReadAloudMode: null }
}

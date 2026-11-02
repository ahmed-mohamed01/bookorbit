import { describe, expect, it } from 'vitest'
import { fakeT as t, readAloudSync } from '@/features/book/lib/__tests__/sync-fixtures'
import { headerStatus, indexStatus, type IndexStatusView, type ReadAlongStatusView } from '../header-status'

const H = 'editionSync.header.'
const S = 'editionSync.status.'
const R = 'book.detail.details.readAloudSync.'

function view(overrides: Partial<IndexStatusView> = {}): IndexStatusView {
  return {
    status: 'ready',
    stage: null,
    progress: null,
    queuePosition: null,
    error: null,
    whisperFallback: false,
    canRunNow: true,
    canRetry: true,
    startingSoon: false,
    when: null,
    ...overrides,
  }
}

function readAlong(sync: Parameters<typeof readAloudSync>[0] = {}, hasEpubCopy = false, hasAudio = true): ReadAlongStatusView {
  return { sync: readAloudSync(sync), audioDuration: '8h 48m', overlayDuration: '8h 41m', hasEpubCopy, hasAudio }
}

describe('indexStatus', () => {
  it('reads off and synced as plain text', () => {
    expect(indexStatus(view({ status: 'off' }), false, t)).toEqual({ text: `${H}off`, tone: 'muted', spinner: false, issue: null })
    expect(indexStatus(view(), false, t)).toEqual({ text: `${H}synced`, tone: 'success', spinner: false, issue: null })
  })

  it('spins with the stage and percent while running, and the stage alone without a percent', () => {
    const running = indexStatus(view({ status: 'running', stage: 'aligning', progress: 42.4 }), false, t)
    expect(running.spinner).toBe(true)
    expect(running.tone).toBe('info')
    expect(running.issue).toBeNull()
    expect(running.text).toMatch(/^editionSync\.header\.running\{"stage":"book\.detail\.files\.readAloud\.stages\.aligning","percent":"42\s?%"\}$/)
    expect(indexStatus(view({ status: 'running', stage: 'aligning', progress: null }), false, t).text).toBe(
      'book.detail.files.readAloud.stages.aligning',
    )
  })

  it('says when a queued book runs and offers Run now behind a clock', () => {
    const queued = indexStatus(view({ status: 'queued', when: 'tonight 02:00', queuePosition: 3 }), false, t)
    expect(queued.text).toBe(`${S}queuedAt{"position":3} · tonight 02:00`)
    expect(queued.issue).toEqual({
      tone: 'info',
      icon: 'clock',
      title: queued.text,
      detail: `${H}detail.queued{"when":"tonight 02:00"}`,
      actions: [{ id: 'run', label: `${S}runNow`, disabled: false }],
    })
    expect(indexStatus(view({ status: 'none' }), true, t).issue?.actions[0]?.disabled).toBe(true)
  })

  it('drops the clock when the run is already starting or cannot start', () => {
    const soon = indexStatus(view({ status: 'queued', startingSoon: true }), false, t)
    expect(soon.text).toBe(`${S}queued · ${S}startingSoon`)
    expect(soon.issue).toBeNull()
    expect(indexStatus(view({ status: 'queued', canRunNow: false }), false, t).issue).toBeNull()
  })

  it('marks a stale index out of date with its explanation and Run now', () => {
    const stale = indexStatus(view({ status: 'stale', when: 'tonight 02:00' }), false, t)
    expect(stale.text).toBe(`${H}outOfDate`)
    expect(stale.issue).toMatchObject({ tone: 'warning', icon: 'clock', detail: `${H}detail.staleAt{"when":"tonight 02:00"}` })
    expect(stale.issue?.actions.map((a) => a.id)).toEqual(['run'])
    expect(indexStatus(view({ status: 'stale', startingSoon: true }), false, t).issue).toMatchObject({ detail: `${H}detail.staleSoon`, actions: [] })
  })

  it('shows a failure with the worker error and Retry indexing', () => {
    const failed = indexStatus(view({ status: 'failed', error: 'No audio stream found in chapter 12.' }), false, t)
    expect(failed.text).toBe(`${H}cantIndex`)
    expect(failed.tone).toBe('destructive')
    expect(failed.issue).toEqual({
      tone: 'destructive',
      icon: 'alert',
      title: `${H}cantIndex`,
      detail: 'No audio stream found in chapter 12.',
      actions: [{ id: 'retry', label: `${H}action.retry`, disabled: false }],
    })
    expect(indexStatus(view({ status: 'failed', canRetry: false }), false, t).issue).toMatchObject({ detail: `${H}detail.failed`, actions: [] })
  })

  it('reads a Whisper fallback as synced with a warning, from a failed or ready index', () => {
    for (const status of ['failed', 'ready'] as const) {
      const whisper = indexStatus(view({ status, whisperFallback: true }), false, t)
      expect(whisper.text).toBe(`${H}viaWhisper`)
      expect(whisper.issue).toMatchObject({ tone: 'warning', icon: 'alert', detail: `${H}detail.whisperFallback` })
      expect(whisper.issue?.actions.map((a) => a.id)).toEqual(['retry'])
    }
  })
})

describe('read-along status', () => {
  function readAlongStatus(readAlong: ReadAlongStatusView, checked: boolean, translate: typeof t) {
    return headerStatus({ kind: 'readAlong', checked, index: null, readAlong, acting: false }, translate)!
  }

  it('reads the mode and an enabled pair as plain text', () => {
    expect(readAlongStatus(readAlong(), false, t).text).toBe(`${H}off`)
    expect(readAlongStatus(readAlong({ state: 'disabled', mode: 'disabled' }), true, t).text).toBe(`${H}off`)
    expect(readAlongStatus(readAlong(), true, t)).toEqual({ text: `${H}synced`, tone: 'success', spinner: false, issue: null })
  })

  it('names a mismatch shortly and explains it with both durations', () => {
    const status = readAlongStatus(readAlong({ state: 'unavailable', unavailableReason: 'duration_mismatch' }), true, t)
    expect(status.text).toBe(`${H}reason.durationMismatch`)
    expect(status.issue).toEqual({
      tone: 'warning',
      icon: 'alert',
      title: `${H}reason.durationMismatch`,
      detail: `${R}reason.durationMismatch{"audio":"8h 48m","overlay":"8h 41m"}`,
      actions: [],
    })
    expect(readAlongStatus(readAlong({ state: 'unavailable', unavailableReason: 'no_audio_files' }), true, t).text).toBe(`${H}reason.noAudioFiles`)
    expect(readAlongStatus(readAlong({ state: 'unavailable', unavailableReason: null }), true, t).text).toBe(`${H}reason.missingDuration`)
  })

  it('reads EPUB only when the copies still sync without the audio half', () => {
    const copies = readAlong({ state: 'unavailable', unavailableReason: 'duration_mismatch' }, true)
    const status = readAlongStatus(copies, true, t)
    expect(status.text).toBe(`${H}epubOnly`)
    expect(status.issue?.detail).toBe(`${R}epubCopiesDescription ${R}reason.durationMismatch{"audio":"8h 48m","overlay":"8h 41m"}`)
    expect(readAlongStatus(readAlong({ state: 'unavailable', unavailableReason: 'no_media_overlay_epub' }, true), true, t).text).toBe(
      `${H}reason.noMediaOverlayEpub`,
    )
  })

  it('reads EPUB copies only as plain synced text when there is no audio to sync', () => {
    const copies = readAlong({ state: 'unavailable', unavailableReason: 'no_audio_files' }, true, false)
    expect(readAlongStatus(copies, true, t)).toEqual({ text: `${R}state.epubCopiesOnly`, tone: 'success', spinner: false, issue: null })
  })
})

describe('headerStatus', () => {
  it('follows the toggle kind and the switch', () => {
    const input = { checked: true, index: view(), readAlong: readAlong(), acting: false }
    expect(headerStatus({ ...input, kind: 'none' }, t)).toBeNull()
    expect(headerStatus({ ...input, kind: 'index', index: null }, t)).toBeNull()
    expect(headerStatus({ ...input, kind: 'index' }, t)?.text).toBe(`${H}synced`)
    expect(headerStatus({ ...input, kind: 'index', checked: false }, t)?.text).toBe(`${H}off`)
    expect(headerStatus({ ...input, kind: 'readAlong' }, t)?.text).toBe(`${H}synced`)
  })
})

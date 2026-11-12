import { describe, expect, it } from 'vitest'
import type { AudioConvertSettings } from '@bookorbit/types'

import {
  AUDIO_CONVERT_POLL_MS,
  AUDIO_CONVERT_WAITING_POLL_MS,
  isAlreadyM4b,
  isJobFinished,
  mergeSavedSettings,
  pollDelay,
  settingsToForm,
} from '../audio-convert'

function saved(overrides: Partial<AudioConvertSettings> = {}): AudioConvertSettings {
  return {
    enabled: true,
    autoConvert: false,
    codec: 'auto',
    bitrate: '128k',
    channels: null,
    embedChapters: true,
    embedMetadata: true,
    backupDays: 14,
    updatedAt: null,
    ...overrides,
  }
}

describe('pollDelay', () => {
  it('polls fast while a job is queued or running, slowly while one only waits, and not at all otherwise', () => {
    expect(pollDelay([{ status: 'waiting' }, { status: 'running' }])).toBe(AUDIO_CONVERT_POLL_MS)
    expect(pollDelay([{ status: 'queued' }])).toBe(AUDIO_CONVERT_POLL_MS)
    expect(pollDelay([{ status: 'waiting' }, { status: 'success' }])).toBe(AUDIO_CONVERT_WAITING_POLL_MS)
    expect(AUDIO_CONVERT_WAITING_POLL_MS).toBeGreaterThanOrEqual(30_000)
    expect(pollDelay([{ status: 'failed' }])).toBeNull()
  })
})

describe('isJobFinished', () => {
  it('counts cancelled jobs as finished', () => {
    expect(isJobFinished({ status: 'cancelled' })).toBe(true)
    expect(isJobFinished({ status: 'success' })).toBe(true)
    expect(isJobFinished({ status: 'waiting' })).toBe(false)
  })
})

describe('isAlreadyM4b', () => {
  it('is true for one M4B or M4A content file and false for MP3s or several files', () => {
    expect(
      isAlreadyM4b([
        { format: 'M4B', role: 'primary' },
        { format: 'jpg', role: 'cover' },
      ]),
    ).toBe(true)
    expect(isAlreadyM4b([{ format: 'm4a', role: 'content' }])).toBe(true)
    expect(isAlreadyM4b([{ format: 'mp3', role: 'content' }])).toBe(false)
    expect(
      isAlreadyM4b([
        { format: 'm4b', role: 'content' },
        { format: 'm4b', role: 'content' },
      ]),
    ).toBe(false)
    expect(isAlreadyM4b([{ format: 'epub', role: 'primary' }])).toBe(false)
  })
})

describe('mergeSavedSettings', () => {
  it('moves untouched fields to the new saved values and keeps edited ones', () => {
    const previous = saved()
    const form = { ...settingsToForm(previous), bitrate: '64k' as const, backupDays: 30 }

    const merged = mergeSavedSettings(form, previous, saved({ enabled: false, bitrate: '96k', backupDays: 7 }))

    expect(merged.enabled).toBe(false)
    expect(merged.bitrate).toBe('64k')
    expect(merged.backupDays).toBe(30)
  })

  it('takes everything on the first load', () => {
    const form = settingsToForm(saved())
    expect(mergeSavedSettings(form, null, saved({ codec: 'aac', channels: 1 }))).toMatchObject({ codec: 'aac', channels: '1' })
  })

  it('treats a cleared number field as edited', () => {
    const previous = saved()
    const form = { ...settingsToForm(previous), backupDays: Number.NaN }
    expect(Number.isNaN(mergeSavedSettings(form, previous, saved({ backupDays: 3 })).backupDays)).toBe(true)
  })
})

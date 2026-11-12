import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { AudioConvertJob, AudioConvertPreviewItem } from '@bookorbit/types'

import AudioConvertDetail from '../AudioConvertDetail.vue'

function job(status: AudioConvertJob['status']): AudioConvertJob {
  return {
    id: 'j1',
    bookId: 1,
    libraryId: 7,
    title: 'Valkyrie',
    trigger: 'auto',
    status,
    stage: status === 'waiting' ? 'chapters' : 'converting',
    progress: status === 'running' ? 40 : null,
    nextStepAt: null,
    codec: null,
    errorCode: null,
    errorMessage: null,
    result: null,
    createdAt: '2026-11-11T10:00:00Z',
    startedAt: null,
    finishedAt: null,
  }
}

function item(status: AudioConvertJob['status']): AudioConvertPreviewItem {
  return {
    bookId: 1,
    title: 'Valkyrie',
    authors: ['Craig Alanson'],
    relativeFolder: 'Craig Alanson/Valkyrie',
    status: 'waiting',
    reason: null,
    fileCount: 2,
    formats: ['mp3'],
    totalBytes: 100,
    totalDurationSeconds: 60,
    job: job(status),
  }
}

function mountDetail(status: AudioConvertJob['status']) {
  return mount(AudioConvertDetail, {
    props: {
      item: item(status),
      plan: null,
      planLoading: false,
      planFailed: false,
      index: 0,
      total: 1,
      selected: false,
      selectedCount: 0,
      backupDays: 14,
      actingJobId: null,
    },
  })
}

function hasPipelineActions(w: ReturnType<typeof mountDetail>): boolean {
  const labels = w.findAll('button').map((b) => b.text())
  return labels.includes('Skip') || labels.some((l) => l.includes('Convert now'))
}

describe('AudioConvertDetail', () => {
  it('offers Skip and Convert now for a waiting job', () => {
    expect(hasPipelineActions(mountDetail('waiting'))).toBe(true)
  })

  it('offers neither once the job is queued or running', () => {
    expect(hasPipelineActions(mountDetail('queued'))).toBe(false)
    expect(hasPipelineActions(mountDetail('running'))).toBe(false)
  })
})

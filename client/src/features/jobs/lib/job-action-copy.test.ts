import { describe, expect, it } from 'vitest'

import { jobActionLabel, jobActionOnLabel, jobResultText } from './job-copy'

describe('Jobs action copy', () => {
  it.each(['edition-sync', 'audio-convert'] as const)('uses the %s move-to-top override', (type) => {
    expect(jobActionLabel('move-to-top', type)).toBe('Move to top')
    expect(jobActionOnLabel('move-to-top', 'Book', type)).toBe('Move to top: Book')
    expect(jobResultText('move-to-top', 1, type)).toBe('Moved 1 job to the top.')
    expect(jobResultText('move-to-top', 2, type)).toBe('Moved 2 jobs to the top.')
  })

  it.each(['web-serial', undefined] as const)('uses generic wording for type %s', (type) => {
    expect(jobActionLabel('move-to-top', type)).toBe('Move to front of my jobs')
    expect(jobActionOnLabel('move-to-top', 'Book', type)).toBe('Move to front of my jobs: Book')
    expect(jobResultText('move-to-top', 1, type)).toBe('Moved 1 job to the front of your jobs.')
    expect(jobActionLabel('cancel', type)).toBe('Cancel')
  })
})

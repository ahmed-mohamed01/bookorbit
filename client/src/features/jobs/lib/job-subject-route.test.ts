import { describe, expect, it } from 'vitest'
import { jobSubjectRoute } from './job-subject-route'

const query = { view: 'needs-you', type: 'request-download', scope: 'everyone' }

describe('jobSubjectRoute', () => {
  it('opens a request under Jobs with its current filters', () => {
    expect(jobSubjectRoute('/requests/42', query)).toEqual({ name: 'jobs-request-detail', params: { id: 42 }, query })
  })

  it.each(['/book/42', '/settings/fork', '/requests', '/requests/42/releases', 'https://example.com/requests/42'])('keeps %s unchanged', (url) => {
    expect(jobSubjectRoute(url, query)).toBe(url)
  })
})

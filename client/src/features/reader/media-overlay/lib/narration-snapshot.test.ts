import { beforeEach, describe, expect, it } from 'vitest'
import { clearSnapshot, readSnapshot, writeSnapshot, type NarrationSnapshot } from './narration-snapshot'

const snapshot: NarrationSnapshot = {
  userId: 1,
  book: { bookId: 1, bookFileId: 2, title: 'Book', author: null, coverUrl: null, totalChapters: 3 },
  fragment: 'c1.xhtml#s1',
  sectionIndex: 1,
  rate: 1,
  trackingEnabled: false,
}

describe('narration snapshot', () => {
  beforeEach(() => {
    clearSnapshot()
  })

  it('round-trips a snapshot including whether progress is tracked', () => {
    writeSnapshot(snapshot, true)

    expect(readSnapshot()).toEqual(snapshot)
  })

  it('throttles unforced writes but not forced ones', () => {
    writeSnapshot(snapshot, true)
    writeSnapshot({ ...snapshot, fragment: 'c1.xhtml#s2' })
    expect(readSnapshot()?.fragment).toBe('c1.xhtml#s1')

    writeSnapshot({ ...snapshot, fragment: 'c1.xhtml#s3' }, true)
    expect(readSnapshot()?.fragment).toBe('c1.xhtml#s3')
  })

  it('ignores a malformed snapshot', () => {
    sessionStorage.setItem('bookorbit.narration.background', JSON.stringify({ ...snapshot, trackingEnabled: undefined }))

    expect(readSnapshot()).toBeNull()
  })
})

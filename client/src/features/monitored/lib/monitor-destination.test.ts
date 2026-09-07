import { describe, expect, it } from 'vitest'
import type { LibraryFolder } from '@bookorbit/types'
import { monitorDestinationDefault } from './monitor-destination'

function library(id: number, folderIds: number[] = []) {
  return { id, folders: folderIds.map((folderId) => ({ id: folderId }) as LibraryFolder) }
}

describe('monitorDestinationDefault', () => {
  it('takes the library and folder the request settings already send this medium to', () => {
    const libraries = [library(1, [10]), library(2, [20, 21])]

    expect(monitorDestinationDefault(libraries, { libraryId: 2, folderId: 21 })).toEqual({ libraryId: 2, folderId: 21 })
  })

  it('keeps the library but drops a folder that belongs to another one', () => {
    const libraries = [library(1, [10]), library(2, [20])]

    expect(monitorDestinationDefault(libraries, { libraryId: 2, folderId: 10 })).toEqual({ libraryId: 2, folderId: null })
  })

  it('stands in the first visible library when the default names one this account cannot reach', () => {
    // The server refuses a monitor pointed at a library the account has no access to, so an
    // instance default naming one must never reach the payload.
    const libraries = [library(3, [30])]

    expect(monitorDestinationDefault(libraries, { libraryId: 9, folderId: 90 })).toEqual({ libraryId: 3, folderId: null })
  })

  it('falls back the same way when no default is set at all', () => {
    expect(monitorDestinationDefault([library(4)], { libraryId: null, folderId: null })).toEqual({ libraryId: 4, folderId: null })
  })

  it('settles on no library when the account can see none', () => {
    expect(monitorDestinationDefault([], { libraryId: 2, folderId: 20 })).toEqual({ libraryId: null, folderId: null })
  })
})

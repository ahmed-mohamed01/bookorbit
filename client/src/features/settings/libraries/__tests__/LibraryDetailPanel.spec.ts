import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Library } from '@bookorbit/types'

import LibraryDetailPanel from '../components/LibraryDetailPanel.vue'

function makeLibrary(overrides: Partial<Library> = {}): Library {
  return {
    id: 1,
    type: 'books',
    name: 'Test Library',
    icon: null,
    displayOrder: 0,
    coverAspectRatio: '2/3',
    watch: false,
    autoScanCronExpression: null,
    metadataPrecedence: ['google'],
    formatPriority: [],
    allowedFormats: ['epub'],
    organizationMode: 'book_per_file',
    addedAtSource: 'imported',
    excludePatterns: ['*.tmp'],
    readingThreshold: 10,
    markAsFinishedPercentComplete: 90,
    fileNamingPattern: null,
    fileWriteEnabled: false,
    fileWriteWriteCover: false,
    fileWriteEpubEnabled: false,
    fileWriteEpubMaxFileSizeMb: 100,
    fileWriteFb2Enabled: false,
    fileWriteFb2MaxFileSizeMb: 100,
    fileWritePdfEnabled: false,
    fileWritePdfMaxFileSizeMb: 100,
    fileWriteCbxEnabled: false,
    fileWriteCbxMaxFileSizeMb: 500,
    fileWriteKindleEnabled: false,
    fileWriteKindleMaxFileSizeMb: 100,
    fileWriteAudioEnabled: false,
    fileWriteAudioMaxFileSizeMb: 500,
    fileRenameEnabled: false,
    folders: [{ id: 1, path: '/books', role: 'downloads' as const, createdAt: '2024-01-01T00:00:00.000Z' }],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function mountPanel(library: Library) {
  return mount(LibraryDetailPanel, {
    props: { library, history: [], accessCount: 1, loading: false, failed: false },
  })
}

describe('LibraryDetailPanel', () => {
  it('shows the configuration rows a superuser is given', () => {
    const wrapper = mountPanel(makeLibrary())

    expect(wrapper.text()).toContain('EPUB')
    expect(wrapper.text()).toContain('Exclude patterns')
    expect(wrapper.text()).toContain('Organization')
    expect(wrapper.text()).toContain('File mode')
  })

  it('names folder mode when that is what the library is organized by', () => {
    const wrapper = mountPanel(makeLibrary({ organizationMode: 'book_per_folder' }))

    expect(wrapper.text()).toContain('Folder mode')
  })

  // GET /api/v1/libraries answers a non-superuser with a narrower projection that leaves these four
  // out, so an admin holding ManageLibraries without being a superuser used to blank the whole panel
  // on `undefined.length`.
  it('renders for an admin the API answered without the configuration columns', () => {
    const reduced = makeLibrary()
    // Everything GET /api/v1/libraries leaves out for a non-superuser, not just the fields that
    // happened to be guarded first: a fixture that omits only some of them asserts the fix while
    // stepping around the rows that still break.
    for (const field of [
      'allowedFormats',
      'excludePatterns',
      'metadataPrecedence',
      'organizationMode',
      'readingThreshold',
      'markAsFinishedPercentComplete',
      'formatPriority',
      'addedAtSource',
      'watch',
      'autoScanCronExpression',
      'fileNamingPattern',
    ] as const) {
      delete (reduced as unknown as Record<string, unknown>)[field]
    }
    delete (reduced as Partial<Library>).organizationMode

    const wrapper = mountPanel(reduced)

    // Left out rather than defaulted: "All supported" would be a lie for a library that restricts
    // formats, and so would "Folder mode" for one that stores a book per file.
    expect(wrapper.text()).not.toContain('EPUB')
    expect(wrapper.text()).not.toContain('Exclude patterns')
    // The rows that are rendered must be true: a missing number used to print as NaN%.
    expect(wrapper.text()).not.toContain('NaN')
    expect(wrapper.text()).not.toContain('undefined')
    expect(wrapper.text()).not.toContain('Organization')
    expect(wrapper.text()).not.toContain('Folder mode')
    // The rows that projection does answer are still there.
    expect(wrapper.text()).toContain('Cover shape')
  })
})

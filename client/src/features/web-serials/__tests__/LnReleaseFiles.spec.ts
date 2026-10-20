import { expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'
import Component from '../components/preview/acquisition/LnReleaseFiles.vue'

it('renders acquisition states and emits controlled interactions', async () => {
  const units = [1, 2, 3, 4, 5].map((n, index) => ({
    index,
    title: n === 5 ? 'Unparsed' : `Novel Vol. ${n}`,
    primaryPath: `${n}.epub`,
    mediaKind: 'ebook' as const,
    sizeBytes: 10,
  }))
  const wrapper = mount(Component, {
    props: {
      manifest: {
        rootName: 'Pack',
        units,
        files: units.map((u) => ({ path: u.primaryPath, sizeBytes: 10, unitIndex: u.index })),
        alreadyImported: [3],
      },
      volumes: [
        { volume: 1, state: 'owned', bookId: 1, error: null },
        { volume: 2, state: 'downloading', bookId: null, error: null },
        { volume: 3, state: 'missing', bookId: null, error: null },
        { volume: 4, state: 'missing', bookId: null, error: null },
        { volume: 5, state: 'missing', bookId: null, error: null },
      ],
    },
    global: { plugins: [i18n] },
  })
  expect(wrapper.emitted('change')![0]).toEqual([new Set([2])])
  const rows = wrapper.findAll('[data-testid="tree-file"]')
  expect(rows[0]!.text()).toContain('In library')
  expect(rows[1]!.text()).toContain('Downloading')
  expect(rows[3]!.text()).toContain('In Book Dock')
  await rows[0]!.trigger('click')
  expect(wrapper.emitted('change')).toHaveLength(1)
})

it('keeps controlled selection stable when the parent echoes a change', async () => {
  const manifest = {
    rootName: 'Pack',
    units: [{ index: 0, title: 'Novel Vol. 1', primaryPath: '1.epub', mediaKind: 'ebook' as const, sizeBytes: 10 }],
    files: [{ path: '1.epub', sizeBytes: 10, unitIndex: 0 }],
  }
  const wrapper = mount(Component, {
    props: { manifest, volumes: [{ volume: 1, state: 'missing', bookId: null, error: null }], selected: new Set([0]) },
    global: { plugins: [i18n] },
  })
  await wrapper.setProps({ selected: new Set([0]) })
  expect(wrapper.emitted('change')).toHaveLength(1)
  await wrapper.get('[data-testid="tree-folder-row"]').trigger('click')
  expect(wrapper.emitted('change')?.at(-1)).toEqual([new Set()])
})

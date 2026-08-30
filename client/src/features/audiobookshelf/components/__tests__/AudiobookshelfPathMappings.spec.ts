import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { AudiobookshelfPathMapping } from '@bookorbit/types'
import AudiobookshelfPathMappings from '../AudiobookshelfPathMappings.vue'

function mountRows(modelValue: AudiobookshelfPathMapping[], disabled = false) {
  return mount(AudiobookshelfPathMappings, { props: { modelValue, disabled } })
}

function mountWithCandidates(modelValue: AudiobookshelfPathMapping[], absFolderPaths: string[], localFolderPaths: string[]) {
  return mount(AudiobookshelfPathMappings, { props: { modelValue, absFolderPaths, localFolderPaths } })
}

function lastEmitted(wrapper: ReturnType<typeof mountRows>): AudiobookshelfPathMapping[] | undefined {
  const events = wrapper.emitted('update:modelValue')
  return events?.at(-1)?.[0] as AudiobookshelfPathMapping[] | undefined
}

describe('AudiobookshelfPathMappings', () => {
  it('renders an empty-state hint and no rows when there are no mappings', () => {
    const wrapper = mountRows([])

    expect(wrapper.findAll('[data-testid="abs-path-prefix"]')).toHaveLength(0)
    expect(wrapper.text()).toContain('No folder mappings')
  })

  it('renders one input pair per mapping', () => {
    const wrapper = mountRows([
      { absPrefix: '/audiobooks', localPrefix: '/books' },
      { absPrefix: '/media/abs', localPrefix: '/media/library' },
    ])

    const absInputs = wrapper.findAll('[data-testid="abs-path-prefix"]')
    const localInputs = wrapper.findAll('[data-testid="local-path-prefix"]')
    expect(absInputs).toHaveLength(2)
    expect((absInputs[1].element as HTMLInputElement).value).toBe('/media/abs')
    expect((localInputs[0].element as HTMLInputElement).value).toBe('/books')
  })

  it('appends an empty row on Add mapping', async () => {
    const wrapper = mountRows([{ absPrefix: '/audiobooks', localPrefix: '/books' }])

    await wrapper.get('[data-testid="add-path-mapping"]').trigger('click')

    expect(lastEmitted(wrapper)).toEqual([
      { absPrefix: '/audiobooks', localPrefix: '/books' },
      { absPrefix: '', localPrefix: '' },
    ])
  })

  it('removes only the row whose remove button was clicked', async () => {
    const wrapper = mountRows([
      { absPrefix: '/a', localPrefix: '/x' },
      { absPrefix: '/b', localPrefix: '/y' },
      { absPrefix: '/c', localPrefix: '/z' },
    ])

    await wrapper.findAll('[data-testid="remove-path-mapping"]')[1].trigger('click')

    expect(lastEmitted(wrapper)).toEqual([
      { absPrefix: '/a', localPrefix: '/x' },
      { absPrefix: '/c', localPrefix: '/z' },
    ])
  })

  it('emits an updated copy when a prefix is edited, leaving other rows untouched', async () => {
    const wrapper = mountRows([
      { absPrefix: '/audiobooks', localPrefix: '/books' },
      { absPrefix: '/media/abs', localPrefix: '/media/library' },
    ])

    await wrapper.findAll('[data-testid="local-path-prefix"]')[0].setValue('/library/books')

    expect(lastEmitted(wrapper)).toEqual([
      { absPrefix: '/audiobooks', localPrefix: '/library/books' },
      { absPrefix: '/media/abs', localPrefix: '/media/library' },
    ])
  })

  it('caps the list at 20 rows by disabling Add mapping', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ absPrefix: `/abs/${i}`, localPrefix: `/books/${i}` }))
    const wrapper = mountRows(rows)

    expect(wrapper.get('[data-testid="add-path-mapping"]').attributes('disabled')).toBeDefined()
  })

  it('opens an aligned option list on focus and selects on click', async () => {
    const wrapper = mountWithCandidates([{ absPrefix: '', localPrefix: '/books' }], ['/audiobooks', '/media/abs'], ['/books'])

    await wrapper.get('[data-testid="abs-path-prefix"]').trigger('focus')
    const options = wrapper.get('[data-testid="abs-path-prefix-options"]').findAll('[role="option"]')
    expect(options.map((option) => option.text())).toEqual(['/audiobooks', '/media/abs'])

    await options[1]!.trigger('click')
    const updates = wrapper.emitted('update:modelValue')
    expect(updates?.at(-1)).toEqual([[{ absPrefix: '/media/abs', localPrefix: '/books' }]])
  })

  it('shows every option on focus even when the row already holds a full path', async () => {
    const wrapper = mountWithCandidates([{ absPrefix: '/audiobooks', localPrefix: '' }], ['/audiobooks', '/media/abs'], ['/books'])

    await wrapper.get('[data-testid="abs-path-prefix"]').trigger('focus')
    const options = wrapper.get('[data-testid="abs-path-prefix-options"]').findAll('[role="option"]')
    expect(options.map((option) => option.text())).toEqual(['/audiobooks', '/media/abs'])
  })

  it('filters only while typing', async () => {
    const wrapperTyped = mountWithCandidates([{ absPrefix: 'media', localPrefix: '' }], ['/audiobooks', '/media/abs'], ['/books'])
    const input = wrapperTyped.get('[data-testid="abs-path-prefix"]')
    await input.trigger('input')
    const options = wrapperTyped.get('[data-testid="abs-path-prefix-options"]').findAll('[role="option"]')
    expect(options.map((option) => option.text())).toEqual(['/media/abs'])
  })

  it('focuses the input when the chevron opens the list, so a blur can dismiss it again', async () => {
    const wrapper = mount(AudiobookshelfPathMappings, {
      props: { modelValue: [{ absPrefix: '', localPrefix: '' }], absFolderPaths: ['/audiobooks', '/media/abs'], localFolderPaths: ['/books'] },
      attachTo: document.body,
    })
    const input = wrapper.get('[data-testid="abs-path-prefix"]')

    await wrapper.get('[aria-label="Show known folders for Audiobookshelf path prefix"]').trigger('click')

    expect(document.activeElement).toBe(input.element)
    const options = wrapper.get('[data-testid="abs-path-prefix-options"]').findAll('[role="option"]')
    expect(options.map((option) => option.text())).toEqual(['/audiobooks', '/media/abs'])

    await input.trigger('blur')

    expect(wrapper.find('[data-testid="abs-path-prefix-options"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('prefills a new row when each side has exactly one candidate', async () => {
    const wrapper = mountWithCandidates([], ['/audiobooks'], ['/books'])

    await wrapper.get('[data-testid="add-path-mapping"]').trigger('click')

    expect(lastEmitted(wrapper)).toEqual([{ absPrefix: '/audiobooks', localPrefix: '/books' }])
  })

  it('adds an empty row when either side has more than one candidate', async () => {
    const wrapper = mountWithCandidates([], ['/audiobooks', '/media/abs'], ['/books'])

    await wrapper.get('[data-testid="add-path-mapping"]').trigger('click')

    expect(lastEmitted(wrapper)).toEqual([{ absPrefix: '', localPrefix: '' }])
  })

  it('adds an empty row when no candidates are known', async () => {
    const wrapper = mountRows([])

    await wrapper.get('[data-testid="add-path-mapping"]').trigger('click')

    expect(lastEmitted(wrapper)).toEqual([{ absPrefix: '', localPrefix: '' }])
  })

  it('renders extra actions beside Add mapping', () => {
    const wrapper = mount(AudiobookshelfPathMappings, {
      props: { modelValue: [] },
      slots: { actions: '<button data-testid="extra-action">Suggest mappings</button>' },
    })

    expect(wrapper.get('[data-testid="extra-action"]').text()).toBe('Suggest mappings')
  })

  it('emits nothing while disabled', async () => {
    const wrapper = mountRows([{ absPrefix: '/audiobooks', localPrefix: '/books' }], true)

    await wrapper.get('[data-testid="remove-path-mapping"]').trigger('click')
    await wrapper.get('[data-testid="add-path-mapping"]').trigger('click')

    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })
})

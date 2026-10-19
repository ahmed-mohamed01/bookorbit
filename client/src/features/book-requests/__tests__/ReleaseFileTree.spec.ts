import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import ReleaseFileTree from '../components/ReleaseFileTree.vue'
import { buildFileTree } from '../composables/useReleaseFileSelection'

type DirState = 'all' | 'some' | 'none' | 'empty'

function mountTree(
  files: { path: string; sizeBytes: number | null; unitIndex: number | null }[],
  opts: { selectable?: boolean; selected?: number[]; state?: DirState; imported?: number[] } = {},
) {
  const tree = buildFileTree({ rootName: 'Pack', units: [], files, alreadyImported: opts.imported })
  const wrapper = mount(ReleaseFileTree, {
    props: {
      tree,
      selectable: opts.selectable ?? true,
      selectedUnits: new Set(opts.selected ?? []),
      dirState: () => opts.state ?? ('none' as DirState),
    },
  })
  return { tree, wrapper }
}

describe('ReleaseFileTree', () => {
  it('renders no checkbox inputs and puts the tree in a dashed container', () => {
    const { wrapper } = mountTree([{ path: 'Book.epub', sizeBytes: 10, unitIndex: 0 }])
    expect(wrapper.findAll('input')).toHaveLength(0)
    expect(wrapper.classes()).toContain('border-dashed')
  })

  it('emits toggle-unit when a book row is clicked and reflects selection in aria-checked', async () => {
    const { wrapper } = mountTree([{ path: 'Book.epub', sizeBytes: 10, unitIndex: 3 }])
    const row = wrapper.get('[data-testid="tree-file"]')
    expect(row.element.tagName).toBe('BUTTON')
    expect(row.attributes('role')).toBe('checkbox')
    expect(row.attributes('aria-checked')).toBe('false')
    expect(wrapper.find('[data-testid="tree-file"] [data-testid="tree-check"]').exists()).toBe(false)
    await row.trigger('click')
    expect(wrapper.emitted('toggle-unit')).toEqual([[3]])
  })

  it('tints a selected book row and shows the filled check box in the slot', () => {
    const { wrapper } = mountTree([{ path: 'Book.epub', sizeBytes: 10, unitIndex: 0 }], { selected: [0] })
    const row = wrapper.get('[data-testid="tree-file"]')
    expect(row.attributes('aria-checked')).toBe('true')
    expect(row.classes()).toContain('bg-primary/10')
    expect(row.find('[data-testid="tree-slot"] [data-testid="tree-box-filled"] [data-testid="tree-check"]').exists()).toBe(true)
    expect(row.find('[data-testid="tree-box-filled"]').classes()).toContain('bg-primary')
  })

  it('renders a hover-reveal empty box in the slot of an unselected book row', () => {
    const { wrapper } = mountTree([{ path: 'Book.epub', sizeBytes: 10, unitIndex: 0 }])
    const row = wrapper.get('[data-testid="tree-file"]')
    const box = row.get('[data-testid="tree-slot"] [data-testid="tree-box-empty"]')
    expect(row.classes()).toContain('group')
    for (const c of [
      'opacity-0',
      'group-hover:opacity-100',
      'group-focus-visible:opacity-100',
      'duration-150',
      'motion-reduce:transition-none',
      'rounded-[3px]',
      'border-[1.5px]',
    ])
      expect(box.classes()).toContain(c)
    expect(box.classes()).toContain('[@media(pointer:coarse)]:opacity-50')
    expect(row.get('[data-testid="tree-slot"]').classes()).toContain('size-4')
  })

  it('keeps an empty same-width slot on non-book files and read-only rows', () => {
    const { wrapper } = mountTree([{ path: 'notes.txt', sizeBytes: 10, unitIndex: null }])
    const slot = wrapper.get('[data-testid="tree-file"] [data-testid="tree-slot"]')
    expect(slot.classes()).toContain('size-4')
    expect(slot.element.children).toHaveLength(0)
    const ro = mountTree([{ path: 'Book.epub', sizeBytes: 10, unitIndex: 0 }], { selectable: false }).wrapper
    for (const row of ro.findAll('[data-testid="tree-slot"]')) {
      expect(row.classes()).toContain('size-4')
      expect(row.element.children).toHaveLength(0)
    }
  })

  it('leaves the slot of a folder without books empty', () => {
    const { wrapper } = mountTree([{ path: 'notes.txt', sizeBytes: 10, unitIndex: null }], { state: 'empty' })
    expect(wrapper.get('[data-testid="tree-folder-row"] [data-testid="tree-slot"]').element.children).toHaveLength(0)
  })

  it('keeps non-book files inert with a Not a book tag', async () => {
    const { wrapper } = mountTree([{ path: 'notes.txt', sizeBytes: 10, unitIndex: null }])
    const row = wrapper.get('[data-testid="tree-file"]')
    expect(row.element.tagName).toBe('DIV')
    expect(row.attributes('role')).toBeUndefined()
    expect(row.classes()).toContain('text-muted-foreground')
    expect(row.text()).toContain('Not a book')
    await row.trigger('click')
    expect(wrapper.emitted('toggle-unit')).toBeUndefined()
  })

  it('emits toggle-dir from the folder row but not from the caret, which only collapses', async () => {
    const { tree, wrapper } = mountTree([{ path: 'Book.epub', sizeBytes: 10, unitIndex: 0 }])
    expect(wrapper.find('[data-testid="tree-file"]').exists()).toBe(true)
    await wrapper.get('[data-testid="tree-folder-icon"]').trigger('click')
    expect(wrapper.emitted('toggle-dir')).toBeUndefined()
    expect(wrapper.find('[data-testid="tree-file"]').exists()).toBe(false)
    await wrapper.get('[data-testid="tree-folder-row"]').trigger('click')
    expect(wrapper.emitted('toggle-dir')).toEqual([[tree]])
  })

  it.each([
    ['all', 'true', 'tree-check'],
    ['some', 'mixed', 'tree-minus'],
    ['none', 'false', null],
  ] as const)('folder state %s maps to aria-checked %s', (state, aria, icon) => {
    const { wrapper } = mountTree([{ path: 'Book.epub', sizeBytes: 10, unitIndex: 0 }], { state })
    const folder = wrapper.get('[data-testid="tree-folder-row"]')
    expect(folder.attributes('aria-checked')).toBe(aria)
    for (const id of ['tree-check', 'tree-minus']) expect(folder.find(`[data-testid="${id}"]`).exists()).toBe(id === icon)
    expect(folder.find('[data-testid="tree-box-filled"]').exists()).toBe(icon !== null)
    expect(folder.find('[data-testid="tree-box-empty"]').exists()).toBe(icon === null)
  })

  it('does not make a folder without books clickable', async () => {
    const { wrapper } = mountTree([{ path: 'notes.txt', sizeBytes: 10, unitIndex: null }], { state: 'empty' })
    const folder = wrapper.get('[data-testid="tree-folder-row"]')
    expect(folder.element.tagName).toBe('DIV')
    expect(folder.attributes('role')).toBeUndefined()
    await folder.trigger('click')
    expect(wrapper.emitted('toggle-dir')).toBeUndefined()
  })

  it('is read-only when not selectable: no checkbox rows and no ticks, caret still expands', async () => {
    const { wrapper } = mountTree([{ path: 'Book.epub', sizeBytes: 10, unitIndex: 0 }], { selectable: false, selected: [0], state: 'all' })
    expect(wrapper.findAll('[role="checkbox"]')).toHaveLength(0)
    expect(wrapper.find('[data-testid="tree-check"]').exists()).toBe(false)
    await wrapper.get('[data-testid="tree-file"]').trigger('click')
    await wrapper.get('[data-testid="tree-folder-row"]').trigger('click')
    expect(wrapper.emitted('toggle-unit')).toBeUndefined()
    expect(wrapper.emitted('toggle-dir')).toBeUndefined()
    await wrapper.get('[data-testid="tree-folder-icon"]').trigger('click')
    expect(wrapper.find('[data-testid="tree-file"]').exists()).toBe(false)
  })

  it('initially scrolls past the muted sibling prefix', async () => {
    const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(120)
    const { wrapper } = mountTree([
      { path: 'Some Very Long Shared Title Volume 01.epub', sizeBytes: 10, unitIndex: 0 },
      { path: 'Some Very Long Shared Title Volume 02.epub', sizeBytes: 10, unitIndex: 1 },
    ])
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-testid="tree-prefix"]').text()).toBe('Some Very Long Shared Title Volume')
    expect((wrapper.get('[data-testid="tree-name"]').element as HTMLElement).scrollLeft).toBe(92)
    width.mockRestore()
  })

  it('suppresses selection after a mouse drag', async () => {
    const { wrapper } = mountTree([{ path: 'Book.epub', sizeBytes: 10, unitIndex: 0 }])
    const row = wrapper.get('[data-testid="tree-file"]')
    row.element.dispatchEvent(Object.assign(new Event('pointerdown', { bubbles: true }), { pointerType: 'mouse', clientX: 10, clientY: 0 }))
    row.element.dispatchEvent(Object.assign(new Event('pointermove', { bubbles: true }), { pointerType: 'mouse', clientX: 30, clientY: 0 }))
    await row.trigger('pointerup')
    await row.trigger('click')
    expect(wrapper.emitted('toggle-unit')).toBeUndefined()
  })

  it('opens the touch sheet without selecting, then selects explicitly', async () => {
    vi.useFakeTimers()
    const { wrapper } = mountTree([{ path: 'Book.epub', sizeBytes: 10, unitIndex: 0 }])
    const row = wrapper.get('[data-testid="tree-file"]')
    row.element.dispatchEvent(Object.assign(new Event('pointerdown', { bubbles: true }), { pointerType: 'touch', clientX: 0, clientY: 0 }))
    await vi.advanceTimersByTimeAsync(500)
    await row.trigger('pointerup')
    await row.trigger('click')
    expect(wrapper.emitted('toggle-unit')).toBeUndefined()
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Book.epub')
    ;(document.querySelector('[data-testid="sheet-select"]') as HTMLElement).click()
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('toggle-unit')).toEqual([[0]])
    wrapper.unmount()
    vi.useRealTimers()
  })

  it('opens levels zero and one while deeper folders start collapsed', () => {
    const { wrapper } = mountTree([{ path: 'One/Two/Book.epub', sizeBytes: 10, unitIndex: 0 }])
    expect(wrapper.findAll('[data-testid="tree-folder"]')).toHaveLength(3)
    expect(wrapper.findAll('[data-testid="tree-folder-icon"]').map((c) => c.attributes('aria-expanded'))).toEqual(['true', 'true', 'false'])
    expect(wrapper.find('[data-testid="tree-file"]').exists()).toBe(false)
  })

  it('shows a Show all row past 200 children', async () => {
    const files = Array.from({ length: 201 }, (_, i) => ({ path: `File ${i}.txt`, sizeBytes: 10, unitIndex: null }))
    const { wrapper } = mountTree(files, { state: 'empty' })
    expect(wrapper.text()).toContain('Show all 201')
    expect(wrapper.findAll('[data-testid="tree-file"]')).toHaveLength(200)
    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('Show all'))!
      .trigger('click')
    expect(wrapper.findAll('[data-testid="tree-file"]')).toHaveLength(201)
  })
})

it('renders imported files and folders as inert muted checks', async () => {
  const { wrapper } = mountTree([{ path: 'Book.epub', sizeBytes: 10, unitIndex: 0 }], { imported: [0] })
  for (const row of [wrapper.get('[data-testid="tree-file"]'), wrapper.get('[data-testid="tree-folder-row"]')]) {
    expect(row.attributes('aria-disabled')).toBe('true')
    expect(row.attributes('role')).toBeUndefined()
    expect(row.find('[data-testid="tree-check"]').exists()).toBe(true)
    expect(row.classes()).not.toContain('group')
    await row.trigger('click')
  }
  expect(wrapper.text()).toContain('In Book Dock')
  expect(wrapper.emitted('toggle-unit')).toBeUndefined()
  expect(wrapper.emitted('toggle-dir')).toBeUndefined()
})
it.each([' ', 'Enter'])('allows keyboard %s after a drag without a click', async (key) => {
  const { wrapper } = mountTree([{ path: 'Book.epub', sizeBytes: 10, unitIndex: 0 }])
  const row = wrapper.get('[data-testid="tree-file"]')
  row.element.dispatchEvent(Object.assign(new Event('pointerdown', { bubbles: true }), { pointerType: 'mouse', clientX: 0, clientY: 0 }))
  row.element.dispatchEvent(Object.assign(new Event('pointermove', { bubbles: true }), { pointerType: 'mouse', clientX: 30, clientY: 0 }))
  await row.trigger('pointerup')
  await row.trigger('keydown', { key })
  await row.trigger('click')
  expect(wrapper.emitted('toggle-unit')).toEqual([[0]])
})
it('omits the size separator for an unknown-size long-press sheet', async () => {
  vi.useFakeTimers()
  const { wrapper } = mountTree([{ path: 'Book.epub', sizeBytes: null, unitIndex: 0 }])
  wrapper
    .get('[data-testid="tree-file"]')
    .element.dispatchEvent(Object.assign(new Event('pointerdown', { bubbles: true }), { pointerType: 'touch', clientX: 0, clientY: 0 }))
  await vi.advanceTimersByTimeAsync(500)
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('book 1 of 1')
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('·')
  wrapper.unmount()
  vi.useRealTimers()
})

import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ReleaseFileTree from '../components/ReleaseFileTree.vue'
import { buildFileTree } from '../composables/useReleaseFileSelection'

type DirState = 'all' | 'some' | 'none' | 'empty'

function mountTree(
  files: { path: string; sizeBytes: number; unitIndex: number | null }[],
  opts: { selectable?: boolean; selected?: number[]; state?: DirState } = {},
) {
  const tree = buildFileTree({ rootName: 'Pack', units: [], files })
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
    await wrapper.get('[data-testid="tree-caret"]').trigger('click')
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
    await wrapper.get('[data-testid="tree-caret"]').trigger('click')
    expect(wrapper.find('[data-testid="tree-file"]').exists()).toBe(false)
  })

  it('splits a long file name into a shrinking ellipsised head and a fixed tail with a full-name title', () => {
    const long = 'Some Very Long Manga Title Volume v01 [Seven Seas] [LuCaZ].epub'
    const { wrapper } = mountTree([{ path: long, sizeBytes: 10, unitIndex: 0 }])
    const name = wrapper.get(`[title="${long}"]`)
    const [head, tail] = Array.from(name.element.querySelectorAll('span'))
    expect(name.classes()).toContain('font-mono')
    expect(head!.className).toContain('sm:text-ellipsis')
    expect(head!.className).toContain('min-w-0')
    expect(tail!.className).toContain('sm:shrink-0')
    expect(head!.textContent! + tail!.textContent!).toBe(long)
  })

  it('opens levels zero and one while deeper folders start collapsed', () => {
    const { wrapper } = mountTree([{ path: 'One/Two/Book.epub', sizeBytes: 10, unitIndex: 0 }])
    expect(wrapper.findAll('[data-testid="tree-folder"]')).toHaveLength(3)
    expect(wrapper.findAll('[data-testid="tree-caret"]').map((c) => c.attributes('aria-expanded'))).toEqual(['true', 'true', 'false'])
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

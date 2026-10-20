import { ref } from 'vue'
import { describe, expect, it } from 'vitest'
import type { ReleaseSelectionManifest } from '@bookorbit/types'
import { buildFileTree, useReleaseFileSelection } from '../composables/useReleaseFileSelection'

function manifest(): ReleaseSelectionManifest {
  return {
    rootName: 'Collection',
    files: [
      ...[10, 2, 3, 4, 5].map((n, index) => ({ path: `Light Novels/Book ${n}.epub`, sizeBytes: 100, unitIndex: index })),
      { path: 'Extras/readme.txt', sizeBytes: 10, unitIndex: null },
      { path: 'Extras/cover.jpg', sizeBytes: 20, unitIndex: null },
    ],
    units: Array.from({ length: 5 }, (_, index) => ({ index, title: `Book ${index}`, mediaKind: 'ebook', sizeBytes: 100, primaryPath: '' })),
  }
}

describe('release file selection', () => {
  it('preselect ticks the returned units on load', () => {
    const selection = useReleaseFileSelection(ref(manifest()), (units) => units.slice(1, 3).map((unit) => unit.index))
    expect([...selection.selectedUnits.value]).toEqual([1, 2])
    expect(selection.selectedSizeBytes.value).toBe(200)
    selection.toggleUnit(1)
    expect(selection.selectedSizeBytes.value).toBe(100)
  })

  it('preselect ignores indexes not in the manifest', () => {
    const data = manifest()
    data.units = [{ ...data.units[0]!, index: 42 }]
    const selection = useReleaseFileSelection(ref(data), () => [-1, 0, 42, 42, 99])
    expect([...selection.selectedUnits.value]).toEqual([42])
  })

  it('without preselect nothing is ticked', () => {
    const source = ref(manifest())
    const selection = useReleaseFileSelection(source)
    expect(selection.selectedUnits.value.size).toBe(0)
    selection.toggleUnit(1)
    source.value = manifest()
    expect(selection.selectedUnits.value.size).toBe(0)
  })

  it('reapplies preselect after clearing on manifest changes', () => {
    const source = ref<ReleaseSelectionManifest | null>(null)
    const selection = useReleaseFileSelection(source, (units) => units.map((unit) => unit.index))
    expect(selection.selectedUnits.value.size).toBe(0)
    source.value = manifest()
    expect(selection.selectedUnits.value.size).toBe(5)
    selection.clear()
    expect(selection.selectedUnits.value.size).toBe(0)
    source.value = { ...manifest(), units: [manifest().units[2]!] }
    expect([...selection.selectedUnits.value]).toEqual([2])
    source.value = null
    expect(selection.selectedUnits.value.size).toBe(0)
  })

  it('builds a tree from the manifest with folder counts', () => {
    const tree = buildFileTree(manifest())
    expect(tree).toMatchObject({ name: 'Collection', path: '', bookCount: 5, fileCount: 7, sizeBytes: 530 })
    expect(tree.children.map((n) => n.name)).toEqual(['Extras', 'Light Novels'])
    expect(tree.children[0]).toMatchObject({ bookCount: 0, fileCount: 2 })
    expect(tree.children[1]).toMatchObject({ bookCount: 5, fileCount: 5 })
    expect(tree.children[1]!.children.map((n) => n.name)).toEqual(['Book 2.epub', 'Book 3.epub', 'Book 4.epub', 'Book 5.epub', 'Book 10.epub'])
    expect(buildFileTree({ rootName: null, files: [], units: [] }).name).toBe('')
  })

  it('ticking a folder ticks every unit under it and unticking clears them', () => {
    const selection = useReleaseFileSelection(ref(manifest()))
    const folder = selection.tree.value!.children[1]!
    selection.toggleDir(folder)
    expect(selection.selectedUnits.value.size).toBe(5)
    expect(selection.dirState(folder)).toBe('all')
    selection.toggleDir(folder)
    expect(selection.selectedUnits.value.size).toBe(0)
    expect(selection.dirState(folder)).toBe('none')
  })

  it('reports some for partial selection and empty for non-book folders', () => {
    const selection = useReleaseFileSelection(ref(manifest()))
    selection.toggleUnit(0)
    expect(selection.dirState(selection.tree.value!)).toBe('some')
    expect(selection.dirState(selection.tree.value!.children[0]!)).toBe('empty')
  })

  it('a unit spread over several files toggles as one', () => {
    const data = manifest()
    data.files = ['Part 1.mp3', 'Part 2.mp3', 'cover.jpg'].map((name, i) => ({ path: `Audio/${name}`, sizeBytes: i + 1, unitIndex: 0 }))
    const selection = useReleaseFileSelection(ref(data))
    expect(selection.tree.value!.bookCount).toBe(1)
    selection.toggleUnit(0)
    expect([...selection.selectedUnits.value]).toEqual([0])
    expect(selection.selectedSizeBytes.value).toBe(6)
    selection.toggleUnit(0)
    expect(selection.selectedSizeBytes.value).toBe(0)
  })

  it('counts units once across folders and preserves unknown sizes', () => {
    const data = manifest()
    data.files = [
      { path: 'Other.epub', sizeBytes: 5, unitIndex: 1 },
      { path: 'A/Part 1.mp3', sizeBytes: 10, unitIndex: 0 },
      { path: 'B/Part 2.mp3', sizeBytes: null, unitIndex: 0 },
    ]
    const selection = useReleaseFileSelection(ref(data))
    const tree = selection.tree.value!
    expect(tree.children.map((node) => node.name)).toEqual(['A', 'B', 'Other.epub'])
    expect(tree.bookCount).toBe(2)
    expect(tree.sizeBytes).toBeNull()
    selection.toggleDir(tree.children[0]!)
    expect(selection.dirState(tree.children[1]!)).toBe('all')
    expect(selection.selectedSizeBytes.value).toBe(10)
  })

  it('sums only ticked units files and clears when the manifest changes', () => {
    const source = ref<ReleaseSelectionManifest | null>(manifest())
    const selection = useReleaseFileSelection(source)
    selection.toggleUnit(0)
    selection.toggleUnit(2)
    expect(selection.selectedSizeBytes.value).toBe(200)
    selection.clear()
    expect(selection.selectedSizeBytes.value).toBe(0)
    selection.toggleUnit(1)
    source.value = null
    expect(selection.tree.value).toBeNull()
    expect(selection.selectedUnits.value.size).toBe(0)
  })
})

it('skips imported units for individual and folder selection', () => {
  const data = manifest()
  data.alreadyImported = [0, 1]
  const selection = useReleaseFileSelection(ref(data))
  selection.toggleUnit(0)
  expect(selection.selectedUnits.value.size).toBe(0)
  selection.toggleDir(selection.tree.value!)
  expect([...selection.selectedUnits.value].sort()).toEqual([2, 3, 4])
})

it('leaves fully imported directories empty of selectable units', () => {
  const data = manifest()
  data.alreadyImported = [0, 1, 2, 3, 4]
  const selection = useReleaseFileSelection(ref(data))
  expect(selection.tree.value!.imported).toBe(true)
  expect(selection.dirState(selection.tree.value!)).toBe('empty')
  selection.toggleDir(selection.tree.value!)
  expect(selection.selectedUnits.value.size).toBe(0)
})

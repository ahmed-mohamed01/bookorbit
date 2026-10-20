import { computed, ref, watch, type Ref } from 'vue'
import type { ReleaseSelectionManifest } from '@bookorbit/types'

export interface FileTreeNode {
  kind: 'dir' | 'file'
  name: string
  path: string
  sizeBytes: number | null
  unitIndex: number | null
  children: FileTreeNode[]
  imported?: boolean
  bookCount: number
  fileCount: number
}

function directory(name: string, path: string): FileTreeNode {
  return { kind: 'dir', name, path, sizeBytes: 0, unitIndex: null, children: [], bookCount: 0, fileCount: 0 }
}

function unitIndexes(node: FileTreeNode): Set<number> {
  const indexes = new Set<number>()
  const pending = [node]
  while (pending.length) {
    const current = pending.pop()!
    if (current.unitIndex !== null) indexes.add(current.unitIndex)
    pending.push(...current.children)
  }
  return indexes
}

export function buildFileTree(manifest: ReleaseSelectionManifest): FileTreeNode {
  const imported = new Set(manifest.alreadyImported ?? [])
  const root = directory(manifest.rootName ?? '', '')
  const directories = new Map<string, FileTreeNode>([['', root]])
  const counts = new Map<FileTreeNode, Set<number>>([[root, new Set()]])
  for (const file of manifest.files) {
    const parts = file.path.split('/')
    const name = parts.pop()!
    let parent = root
    const ancestors = [root]
    for (const part of parts) {
      const path = parent.path ? `${parent.path}/${part}` : part
      let child = directories.get(path)
      if (!child) {
        child = directory(part, path)
        directories.set(path, child)
        counts.set(child, new Set())
        parent.children.push(child)
      }
      parent = child
      ancestors.push(parent)
    }
    parent.children.push({
      imported: file.unitIndex !== null && imported.has(file.unitIndex),
      kind: 'file',
      name,
      path: file.path,
      sizeBytes: file.sizeBytes,
      unitIndex: file.unitIndex,
      children: [],
      bookCount: file.unitIndex === null ? 0 : 1,
      fileCount: 1,
    })
    for (const ancestor of ancestors) {
      ancestor.fileCount += 1
      if (ancestor.sizeBytes !== null) ancestor.sizeBytes = file.sizeBytes === null ? null : ancestor.sizeBytes + file.sizeBytes
      if (file.unitIndex !== null) counts.get(ancestor)!.add(file.unitIndex)
    }
  }
  for (const node of directories.values()) {
    node.bookCount = counts.get(node)!.size
    node.imported = node.bookCount > 0 && [...counts.get(node)!].every((index) => imported.has(index))
    node.children.sort((a, b) => Number(b.kind === 'dir') - Number(a.kind === 'dir') || a.name.localeCompare(b.name, undefined, { numeric: true }))
  }
  return root
}

export function useReleaseFileSelection(
  manifest: Ref<ReleaseSelectionManifest | null>,
  preselect?: (units: ReleaseSelectionManifest['units']) => number[],
) {
  const tree = computed(() => (manifest.value ? buildFileTree(manifest.value) : null))
  const selectedUnits = ref(new Set<number>())
  function clear() {
    selectedUnits.value = new Set()
  }
  const imported = computed(() => new Set(manifest.value?.alreadyImported ?? []))
  function selectableIndexes(node: FileTreeNode) {
    return new Set([...unitIndexes(node)].filter((index) => !imported.value.has(index)))
  }
  watch(
    manifest,
    (current) => {
      clear()
      if (!current || !preselect) return
      const validIndexes = new Set(current.units.map((unit) => unit.index))
      const alreadyImported = new Set(current.alreadyImported ?? [])
      selectedUnits.value = new Set(preselect(current.units).filter((index) => validIndexes.has(index) && !alreadyImported.has(index)))
    },
    { flush: 'sync', immediate: true },
  )
  function toggleUnit(index: number) {
    if (imported.value.has(index)) return
    if (!manifest.value?.units.some((unit) => unit.index === index)) return
    if (selectedUnits.value.has(index)) selectedUnits.value.delete(index)
    else selectedUnits.value.add(index)
  }
  function dirState(node: FileTreeNode): 'all' | 'some' | 'none' | 'empty' {
    const indexes = selectableIndexes(node)
    if (!indexes.size) return 'empty'
    let selected = 0
    for (const index of indexes) if (selectedUnits.value.has(index)) selected += 1
    return selected === indexes.size ? 'all' : selected ? 'some' : 'none'
  }
  function toggleDir(node: FileTreeNode) {
    const indexes = selectableIndexes(node)
    const remove = dirState(node) === 'all'
    for (const index of indexes) {
      if (remove) selectedUnits.value.delete(index)
      else selectedUnits.value.add(index)
    }
  }
  const selectedSizeBytes = computed(() =>
    (manifest.value?.files ?? []).reduce(
      (size, file) => size + (file.unitIndex !== null && selectedUnits.value.has(file.unitIndex) ? (file.sizeBytes ?? 0) : 0),
      0,
    ),
  )
  return { tree, selectedUnits, toggleUnit, toggleDir, dirState, selectedSizeBytes, clear }
}

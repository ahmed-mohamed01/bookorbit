import { computed, ref, watch, type Ref } from 'vue'
import type { ReleaseSelectionManifest } from '@bookorbit/types'

export interface FileTreeNode {
  kind: 'dir' | 'file'
  name: string
  path: string
  sizeBytes: number | null
  unitIndex: number | null
  children: FileTreeNode[]
  bookCount: number
  fileCount: number
}

export function splitForMiddleEllipsis(name: string, tail = 28): { head: string; tail: string } {
  const chars = Array.from(name)
  if (chars.length <= tail) return { head: '', tail: name }
  return { head: chars.slice(0, chars.length - tail).join(''), tail: chars.slice(chars.length - tail).join('') }
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
    node.children.sort((a, b) => Number(b.kind === 'dir') - Number(a.kind === 'dir') || a.name.localeCompare(b.name, undefined, { numeric: true }))
  }
  return root
}

export function useReleaseFileSelection(manifest: Ref<ReleaseSelectionManifest | null>) {
  const tree = computed(() => (manifest.value ? buildFileTree(manifest.value) : null))
  const selectedUnits = ref(new Set<number>())
  function clear() {
    selectedUnits.value = new Set()
  }
  watch(manifest, clear, { flush: 'sync' })
  function toggleUnit(index: number) {
    if (!manifest.value?.units.some((unit) => unit.index === index)) return
    if (selectedUnits.value.has(index)) selectedUnits.value.delete(index)
    else selectedUnits.value.add(index)
  }
  function dirState(node: FileTreeNode): 'all' | 'some' | 'none' | 'empty' {
    const indexes = unitIndexes(node)
    if (!indexes.size) return 'empty'
    let selected = 0
    for (const index of indexes) if (selectedUnits.value.has(index)) selected += 1
    return selected === indexes.size ? 'all' : selected ? 'some' : 'none'
  }
  function toggleDir(node: FileTreeNode) {
    const indexes = unitIndexes(node)
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

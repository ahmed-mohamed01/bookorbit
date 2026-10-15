export const PATH_ELLIPSIS = '…'
const MAX_FOLDER_LINES = 6
const KEPT_FOLDER_LINES = 4
export const MAX_SIBLING_LINES = 12

export type OwnedFileKind = 'ebook' | 'audio' | 'image' | 'other'

export interface OwnedPathFile {
  absolutePath: string
  filename?: string | null
}

export interface OwnedTreeRow {
  type: 'folder' | 'file'
  depth: number
  name: string
  kind?: OwnedFileKind
  primary?: boolean
}

export interface OwnedTree {
  folders: string[]
  folderPath: string
  rows: OwnedTreeRow[]
  moreCount: number
}

const EBOOK_EXTENSIONS = new Set(['epub', 'kepub', 'pdf', 'mobi', 'azw', 'azw3', 'fb2', 'cbz', 'cbr', 'cb7', 'txt', 'djvu', 'lit'])
const AUDIO_EXTENSIONS = new Set(['m4b', 'm4a', 'mp3', 'flac', 'ogg', 'opus', 'aac', 'wav', 'wma'])
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp'])

export function splitPath(path: string | null | undefined): string[] {
  return (path ?? '').split(/[\\/]/).filter(Boolean)
}

export function fileKind(name: string): OwnedFileKind {
  const dot = name.lastIndexOf('.')
  const extension = dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
  if (EBOOK_EXTENSIONS.has(extension)) return 'ebook'
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio'
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  return 'other'
}

function startsWith(segments: string[], prefix: string[]): boolean {
  return prefix.length <= segments.length && prefix.every((segment, index) => segments[index] === segment)
}

function commonPrefix(lists: string[][]): string[] {
  const [first, ...rest] = lists
  if (!first) return []
  let length = first.length
  for (const list of rest) {
    let shared = 0
    while (shared < length && shared < list.length && list[shared] === first[shared]) shared += 1
    length = shared
  }
  return first.slice(0, length)
}

function baseFolders(primaryFolders: string[], allFolders: string[][], roots: readonly string[]): string[] {
  let best: string[] = []
  for (const root of roots) {
    const rootSegments = splitPath(root)
    if (rootSegments.length > best.length && startsWith(primaryFolders, rootSegments)) best = rootSegments
  }
  if (best.length > 0) return best
  return commonPrefix(allFolders)
}

function collapseFolders(folders: string[]): string[] {
  return folders.length > MAX_FOLDER_LINES ? [PATH_ELLIPSIS, ...folders.slice(-KEPT_FOLDER_LINES)] : folders
}

function fileName(file: OwnedPathFile): string {
  return file.filename || splitPath(file.absolutePath).at(-1) || ''
}

interface Sibling {
  name: string
  subfolders: string[]
  kind: OwnedFileKind
}

function collectSiblings(primarySegments: string[], primaryFolders: string[], files: readonly OwnedPathFile[]): Sibling[] {
  const siblings: Sibling[] = []
  for (const file of files) {
    const segments = splitPath(file.absolutePath)
    if (segments.length === primarySegments.length && startsWith(segments, primarySegments)) continue
    const folders = segments.slice(0, -1)
    if (!startsWith(folders, primaryFolders)) continue
    const name = fileName(file)
    siblings.push({ name, subfolders: folders.slice(primaryFolders.length), kind: fileKind(name) })
  }
  return siblings.sort((a, b) => a.subfolders.join('/').localeCompare(b.subfolders.join('/')) || a.name.localeCompare(b.name))
}

/**
 * The tree under a library line: the folders from the library's root down to the primary file, the
 * primary file, and the book's other files that sit in the same folder or below it. Only files the
 * book already reports are listed.
 */
export function buildOwnedTree(
  primary: OwnedPathFile,
  files: readonly OwnedPathFile[],
  roots: readonly string[],
  primaryFallbackKind: OwnedFileKind = 'other',
): OwnedTree {
  const primarySegments = splitPath(primary.absolutePath)
  const primaryFolders = primarySegments.slice(0, -1)
  const allFolders = [primary, ...files].map((file) => splitPath(file.absolutePath).slice(0, -1))
  const base = baseFolders(primaryFolders, allFolders, roots)
  const relative = primaryFolders.slice(base.length)
  const folders = collapseFolders(relative)
  const depth = folders.length + 1

  const primaryName = fileName(primary)
  const primaryKind = fileKind(primaryName)
  const siblings = collectSiblings(primarySegments, primaryFolders, files)
  const shown = siblings.slice(0, MAX_SIBLING_LINES)

  const rows: OwnedTreeRow[] = []
  const direct = shown.filter((sibling) => sibling.subfolders.length === 0)
  const primaryRow: OwnedTreeRow = {
    type: 'file',
    depth,
    name: primaryName,
    kind: primaryKind === 'other' ? primaryFallbackKind : primaryKind,
    primary: true,
  }
  const before = direct.filter((sibling) => sibling.name.localeCompare(primaryName) < 0)
  const after = direct.filter((sibling) => sibling.name.localeCompare(primaryName) >= 0)
  for (const sibling of before) rows.push({ type: 'file', depth, name: sibling.name, kind: sibling.kind })
  rows.push(primaryRow)
  for (const sibling of after) rows.push({ type: 'file', depth, name: sibling.name, kind: sibling.kind })

  let lastGroup = ''
  for (const sibling of shown) {
    if (sibling.subfolders.length === 0) continue
    const group = sibling.subfolders.join('/')
    if (group !== lastGroup) {
      lastGroup = group
      rows.push({ type: 'folder', depth, name: sibling.subfolders.join('/') })
    }
    rows.push({ type: 'file', depth: depth + 1, name: sibling.name, kind: sibling.kind })
  }

  return { folders, folderPath: relative.join('/'), rows, moreCount: siblings.length - shown.length }
}

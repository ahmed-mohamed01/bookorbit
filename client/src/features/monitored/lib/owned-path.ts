export const PATH_ELLIPSIS = '…'
const MAX_FOLDER_LINES = 6
const KEPT_FOLDER_LINES = 4

export type OwnedFileKind = 'ebook' | 'audio' | 'image' | 'other'

export interface OwnedPathFile {
  absolutePath: string
  filename?: string | null
  sizeBytes?: number | null
  durationSeconds?: number | null
}

export interface OwnedTreeRow {
  type: 'folder' | 'file'
  depth: number
  name: string
  kind?: OwnedFileKind
  primary?: boolean
  /** One of this format's own files, which the "Show all N files" count and the duration total cover. */
  content?: boolean
  sizeBytes?: number | null
  durationSeconds?: number | null
}

export interface OwnedTree {
  folders: string[]
  folderPath: string
  rows: OwnedTreeRow[]
  /** How many of the rows are ebook or audio files, the same count the card's stat line shows. */
  contentCount: number
  /** The files' total listening time; zero unless the format is an audiobook. */
  durationSeconds: number
  /** The cover image filed next to the content files, if the book reports one. */
  coverFileName: string | null
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
  path: string
  name: string
  subfolders: string[]
  kind: OwnedFileKind
  content: boolean
  sizeBytes: number | null
  durationSeconds: number | null
}

function isContentKind(kind: OwnedFileKind): boolean {
  return kind === 'ebook' || kind === 'audio'
}

/** The book's files under the anchor folder, the primary among them, sorted by subfolder then name. */
function collectFiles(
  primary: OwnedPathFile,
  files: readonly OwnedPathFile[],
  anchor: string[],
  isContent: (path: string, kind: OwnedFileKind) => boolean,
): Sibling[] {
  const seen = new Set<string>()
  const collected: Sibling[] = []
  for (const file of [primary, ...files]) {
    if (seen.has(file.absolutePath)) continue
    seen.add(file.absolutePath)
    const folders = splitPath(file.absolutePath).slice(0, -1)
    if (!startsWith(folders, anchor)) continue
    const name = fileName(file)
    const kind = fileKind(name)
    collected.push({
      path: file.absolutePath,
      name,
      subfolders: folders.slice(anchor.length),
      kind,
      content: file.absolutePath === primary.absolutePath || isContent(file.absolutePath, kind),
      sizeBytes: file.sizeBytes ?? null,
      durationSeconds: file.durationSeconds ?? null,
    })
  }
  return collected.sort((a, b) => a.subfolders.join('/').localeCompare(b.subfolders.join('/')) || a.name.localeCompare(b.name))
}

/**
 * The tree under a library line: the folders from the library's root down to the folder that holds
 * this format's files, then those files and the book's other files beside or below them. `contentPaths`
 * names this format's own files, the same set the card's stat line counts; without it the extension
 * decides. Only files the book already reports are listed.
 */
export function buildOwnedTree(
  primary: OwnedPathFile,
  files: readonly OwnedPathFile[],
  roots: readonly string[],
  primaryFallbackKind: OwnedFileKind = 'other',
  contentPaths?: readonly string[],
): OwnedTree {
  const contentSet = contentPaths?.length ? new Set(contentPaths) : null
  const isContent = (path: string, kind: OwnedFileKind) => (contentSet ? contentSet.has(path) : isContentKind(kind))
  const primarySegments = splitPath(primary.absolutePath)
  const primaryFolders = primarySegments.slice(0, -1)
  // A multi-disc audiobook keeps its parts in sibling folders, so the tree hangs from their shared folder.
  const contentFolders = contentSet
    ? files.filter((file) => contentSet.has(file.absolutePath)).map((file) => splitPath(file.absolutePath).slice(0, -1))
    : []
  const anchor = commonPrefix([primaryFolders, ...contentFolders])
  const allFolders = [primary, ...files].map((file) => splitPath(file.absolutePath).slice(0, -1))
  const base = baseFolders(anchor, allFolders, roots)
  const relative = anchor.slice(base.length)
  const folders = collapseFolders(relative)
  const depth = folders.length + 1

  const all = collectFiles(primary, files, anchor, isContent)
  const fileRow = (file: Sibling, rowDepth: number): OwnedTreeRow => ({
    type: 'file',
    depth: rowDepth,
    name: file.name,
    kind: file.path === primary.absolutePath && file.kind === 'other' ? primaryFallbackKind : file.kind,
    content: file.content,
    ...(file.path === primary.absolutePath ? { primary: true } : {}),
    sizeBytes: file.sizeBytes,
    durationSeconds: file.durationSeconds,
  })
  const direct = all.filter((file) => file.subfolders.length === 0)
  const grouped = all.filter((file) => file.subfolders.length > 0)
  const isPrimary = (file: Sibling) => file.path === primary.absolutePath

  // The primary file is the headline, content files follow it, and sidecars and the cover image close
  // the list so a card capped at three rows never spends one on metadata or artwork.
  const rows: OwnedTreeRow[] = []
  for (const file of direct.filter(isPrimary)) rows.push(fileRow(file, depth))
  for (const file of direct.filter((file) => file.content && !isPrimary(file))) rows.push(fileRow(file, depth))
  for (const file of direct.filter((file) => !file.content && file.kind !== 'image')) rows.push(fileRow(file, depth))

  let lastGroup = ''
  for (const file of grouped) {
    const group = file.subfolders.join('/')
    if (group !== lastGroup) {
      lastGroup = group
      rows.push({ type: 'folder', depth, name: group })
    }
    rows.push(fileRow(file, depth + 1))
  }
  for (const file of direct.filter((file) => !file.content && file.kind === 'image')) rows.push(fileRow(file, depth))

  const contentRows = rows.filter((row) => row.content)
  return {
    folders,
    folderPath: relative.join('/'),
    rows,
    contentCount: contentRows.length,
    durationSeconds: contentRows.reduce((total, row) => total + (row.durationSeconds ?? 0), 0),
    coverFileName: all.find((file) => !file.content && file.kind === 'image')?.name ?? null,
  }
}

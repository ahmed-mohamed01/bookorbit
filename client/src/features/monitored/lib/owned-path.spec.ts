import { describe, expect, it } from 'vitest'
import { buildOwnedTree, fileKind } from './owned-path'

const primary = { absolutePath: '/mnt/data/media/Fiction/Author/Title/Title.epub', filename: 'Title.epub' }

describe('buildOwnedTree', () => {
  it('uses the library root and never a placeholder', () => {
    const tree = buildOwnedTree(primary, [primary], ['/mnt/data/media/Fiction'])
    expect(tree.folders).toEqual(['Author', 'Title'])
    expect(tree.folderPath).toBe('Author/Title')
  })

  it('picks the longest matching root', () => {
    const tree = buildOwnedTree(primary, [primary], ['/mnt/data', '/mnt/data/media/Fiction'])
    expect(tree.folders).toEqual(['Author', 'Title'])
  })

  it('falls back to the common prefix of the book files without a root', () => {
    const other = { absolutePath: '/mnt/data/media/Fiction/Author/Other/Other.m4b', filename: 'Other.m4b' }
    const tree = buildOwnedTree(primary, [primary, other], [])
    expect(tree.folders).toEqual(['Title'])
  })

  it('shows no folder lines when one file is all there is and no root is known', () => {
    expect(buildOwnedTree(primary, [primary], []).folders).toEqual([])
  })

  it('collapses past six folder lines keeping the last four', () => {
    const deep = { absolutePath: '/r/a/b/c/d/e/f/g/file.epub', filename: 'file.epub' }
    expect(buildOwnedTree(deep, [deep], ['/r']).folders).toEqual(['…', 'd', 'e', 'f', 'g'])
    expect(buildOwnedTree(deep, [deep], ['/r/a']).folders).toEqual(['b', 'c', 'd', 'e', 'f', 'g'])
  })

  it('reads backslash paths', () => {
    const win = { absolutePath: 'C:\\Books\\Author\\file.epub', filename: 'file.epub' }
    expect(buildOwnedTree(win, [win], ['C:\\Books']).folders).toEqual(['Author'])
  })

  it('lists files in the same folder around the primary, sorted by name', () => {
    const cover = { absolutePath: '/mnt/data/media/Fiction/Author/Title/cover.jpg', filename: 'cover.jpg' }
    const zed = { absolutePath: '/mnt/data/media/Fiction/Author/Title/zed.pdf', filename: 'zed.pdf' }
    const elsewhere = { absolutePath: '/mnt/data/media/Fiction/Author/Else/x.epub', filename: 'x.epub' }
    const tree = buildOwnedTree(primary, [zed, primary, elsewhere, cover], ['/mnt/data/media/Fiction'])
    expect(tree.rows.map((row) => [row.name, row.kind, row.primary ?? false])).toEqual([
      ['cover.jpg', 'image', false],
      ['Title.epub', 'ebook', true],
      ['zed.pdf', 'ebook', false],
    ])
  })

  it('groups files in a subfolder under its line', () => {
    const track = { absolutePath: '/lib/Book/Book.m4b', filename: 'Book.m4b' }
    const cd = [1, 2].map((n) => ({ absolutePath: `/lib/Book/CD1/${n}.mp3`, filename: `${n}.mp3` }))
    const tree = buildOwnedTree(track, [track, ...cd], ['/lib'])
    expect(tree.rows).toEqual([
      { type: 'file', depth: 2, name: 'Book.m4b', kind: 'audio', primary: true },
      { type: 'folder', depth: 2, name: 'CD1' },
      { type: 'file', depth: 3, name: '1.mp3', kind: 'audio' },
      { type: 'file', depth: 3, name: '2.mp3', kind: 'audio' },
    ])
  })

  it('caps siblings at twelve and counts the rest', () => {
    const many = Array.from({ length: 15 }, (_, n) => ({
      absolutePath: `/lib/Book/t${String(n).padStart(2, '0')}.mp3`,
      filename: `t${String(n).padStart(2, '0')}.mp3`,
    }))
    const main = { absolutePath: '/lib/Book/Book.m4b', filename: 'Book.m4b' }
    const tree = buildOwnedTree(main, [main, ...many], ['/lib'])
    expect(tree.rows.filter((row) => !row.primary)).toHaveLength(12)
    expect(tree.moreCount).toBe(3)
  })
})

describe('fileKind', () => {
  it('classifies by extension', () => {
    expect(fileKind('a.EPUB')).toBe('ebook')
    expect(fileKind('a.m4b')).toBe('audio')
    expect(fileKind('a.png')).toBe('image')
    expect(fileKind('a.nfo')).toBe('other')
    expect(fileKind('noext')).toBe('other')
  })
})

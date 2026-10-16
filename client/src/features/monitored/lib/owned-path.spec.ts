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

  it('leads with the primary, follows with content files and closes with the cover image', () => {
    const cover = { absolutePath: '/mnt/data/media/Fiction/Author/Title/cover.jpg', filename: 'cover.jpg' }
    const zed = { absolutePath: '/mnt/data/media/Fiction/Author/Title/zed.pdf', filename: 'zed.pdf' }
    const elsewhere = { absolutePath: '/mnt/data/media/Fiction/Author/Else/x.epub', filename: 'x.epub' }
    const tree = buildOwnedTree(primary, [zed, primary, elsewhere, cover], ['/mnt/data/media/Fiction'])
    expect(tree.rows.map((row) => [row.name, row.kind, row.primary ?? false])).toEqual([
      ['Title.epub', 'ebook', true],
      ['zed.pdf', 'ebook', false],
      ['cover.jpg', 'image', false],
    ])
    expect(tree.coverFileName).toBe('cover.jpg')
    expect(tree.contentCount).toBe(2)
  })

  it('puts sidecar files after the audio parts and leaves them out of the file count', () => {
    const dir = '/mnt/a/Audio/Author/Book'
    const part1 = { absolutePath: `${dir}/Book 01.mp3`, filename: 'Book 01.mp3' }
    const files = [part1, { absolutePath: `${dir}/Book 02.mp3` }, { absolutePath: `${dir}/metadata.json` }, { absolutePath: `${dir}/Book 03.mp3` }]
    const tree = buildOwnedTree(part1, files, ['/mnt/a/Audio'], 'audio')
    expect(tree.rows.map((row) => row.name)).toEqual(['Book 01.mp3', 'Book 02.mp3', 'Book 03.mp3', 'metadata.json'])
    expect(tree.contentCount).toBe(3)
  })

  it('groups files in a subfolder under its line', () => {
    const track = { absolutePath: '/lib/Book/Book.m4b', filename: 'Book.m4b' }
    const cd = [1, 2].map((n) => ({ absolutePath: `/lib/Book/CD1/${n}.mp3`, filename: `${n}.mp3` }))
    const tree = buildOwnedTree(track, [track, ...cd], ['/lib'])
    expect(tree.rows).toEqual([
      { type: 'file', depth: 2, name: 'Book.m4b', kind: 'audio', content: true, primary: true, sizeBytes: null, durationSeconds: null },
      { type: 'folder', depth: 2, name: 'CD1' },
      { type: 'file', depth: 3, name: '1.mp3', kind: 'audio', content: true, sizeBytes: null, durationSeconds: null },
      { type: 'file', depth: 3, name: '2.mp3', kind: 'audio', content: true, sizeBytes: null, durationSeconds: null },
    ])
  })

  it('hangs a multi-disc audiobook from the folder its parts share, so every disc is listed and timed', () => {
    const disc = (n: number, part: number) => ({ absolutePath: `/lib/Book/CD${n}/${part}.mp3`, durationSeconds: 100 })
    const parts = [disc(1, 1), disc(1, 2), disc(2, 1), disc(2, 2)]
    const tree = buildOwnedTree(
      parts[0]!,
      parts,
      ['/lib'],
      'audio',
      parts.map((part) => part.absolutePath),
    )
    expect(tree.folders).toEqual(['Book'])
    expect(tree.rows.filter((row) => row.type === 'folder').map((row) => row.name)).toEqual(['CD1', 'CD2'])
    expect(tree.contentCount).toBe(4)
    expect(tree.durationSeconds).toBe(400)
  })

  it("counts only this format's own files as content, whatever their extension", () => {
    const dir = '/lib/Audio/Book'
    const m4b = { absolutePath: `${dir}/book.m4b` }
    const files = [m4b, { absolutePath: `${dir}/desc.txt` }, { absolutePath: `${dir}/reader.txt` }, { absolutePath: `${dir}/cover.jpg` }]
    const tree = buildOwnedTree(m4b, files, ['/lib/Audio'], 'audio', [m4b.absolutePath])
    expect(tree.contentCount).toBe(1)
    expect(tree.rows.filter((row) => row.content).map((row) => row.name)).toEqual(['book.m4b'])
    expect(tree.rows.at(-1)?.name).toBe('cover.jpg')
  })

  it('keeps every file and carries its size and duration for the card to cap', () => {
    const many = Array.from({ length: 15 }, (_, n) => ({
      absolutePath: `/lib/Book/t${String(n).padStart(2, '0')}.mp3`,
      filename: `t${String(n).padStart(2, '0')}.mp3`,
      sizeBytes: 1024,
      durationSeconds: 300,
    }))
    const main = { absolutePath: '/lib/Book/Book.m4b', filename: 'Book.m4b', sizeBytes: 2048, durationSeconds: 600 }
    const tree = buildOwnedTree(main, [main, ...many], ['/lib'])
    expect(tree.rows).toHaveLength(16)
    expect(tree.rows[0]).toMatchObject({ name: 'Book.m4b', primary: true, sizeBytes: 2048, durationSeconds: 600 })
    expect(tree.contentCount).toBe(16)
    expect(tree.durationSeconds).toBe(600 + 15 * 300)
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

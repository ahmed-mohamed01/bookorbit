import { narratedPieces } from './index-narration'

type MediaOverlayItem = { text: string }

// The elements a SMIL <text> reference narrates, looked up the way foliate's
// resolveHref does, so starting and highlighting agree on the element.
// Fork: every piece of a sentence read along from a timing index.
function narratedElements(doc: Document, text: string): Element[] {
  const id = text.split('#')[1]
  if (!id) return []
  const pieces = narratedPieces(doc, id)
  const named = doc.getElementsByName(id)[0]
  return pieces.length || !named ? pieces : [named]
}

// Accepts the SMIL entries whose narrated element overlaps `range`, so
// foliate, which walks entries in reading order, starts at the first narrated
// sentence the range touches.
//
// Only the overlay knows which ids are narrated. Storyteller wraps each
// sentence in its own span but keeps the book's inline elements inside it with
// their ids (Kobo's `kobo.N.N`, calibre's `calibre_link-N`), so the id nearest
// the selected text is often one no SMIL entry names.
export function mediaOverlayEntriesOverlapping(range: Range): (item: MediaOverlayItem) => boolean {
  const doc = range.startContainer.ownerDocument ?? (range.startContainer as Document)
  return (item) => {
    try {
      return narratedElements(doc, item.text).some((element) => range.intersectsNode(element))
    } catch {
      return false
    }
  }
}

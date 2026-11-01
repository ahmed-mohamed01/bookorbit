/**
 * Extension seam for book files that are EPUB zips under another format name.
 *
 * `EpubDomService` reads spines and chapters only from `epub` and `kepub` rows. A resolver may map
 * another row to an EPUB it can read. With no resolver registered the service behaves exactly as
 * it does without this seam.
 */
export const EPUB_DOM_SOURCE_RESOLVER = Symbol('EPUB_DOM_SOURCE_RESOLVER');

export interface EpubDomSourceResolver {
  resolveEpubDomSource(
    bookFileId: number,
    file: { absolutePath: string; format: string | null },
  ): Promise<{ absolutePath: string; format: 'epub' } | null>;
}

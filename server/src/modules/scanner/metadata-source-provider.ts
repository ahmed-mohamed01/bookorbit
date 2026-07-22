/**
 * Extension seam for metadata sources the scanner can read during a scan.
 *
 * The scanner ships `embedded` and `opfFile` built in. `LIBRARY_METADATA_PRECEDENCE_DEFAULT`
 * additionally advertises `folderStructure`, `nfoFile` and `sidecar`, which have no built-in
 * implementation - a provider registered under one of those keys is what makes the corresponding
 * precedence entry do anything.
 *
 * Providers are optional. With none registered the scanner behaves exactly as it does without this
 * seam: unimplemented precedence entries are skipped.
 */
export const EXTRA_METADATA_SOURCES = Symbol('EXTRA_METADATA_SOURCES');

/** Minimum shape a provider needs to pick a file; the scanner passes its own richer type through. */
export interface MetadataSourceFile {
  format: string | null;
  role: string;
  absolutePath: string;
}

export interface MetadataSourceProvider {
  /** Precedence key this provider implements, e.g. `sidecar`. Also used as the cover source kind. */
  readonly key: string;
  /** Returns the file to read for this source, plus the format to parse it as, or null if absent. */
  select<T extends MetadataSourceFile>(files: readonly T[]): { file: T; format: string } | null;
  /**
   * Optional cover image belonging to this source. The scanner owns the generic orchestration
   * (change detection, clobber guards, precedence); the provider owns only which file it is.
   * Applied through `EXTRA_COVER_SOURCE_HANDLERS` using a handler whose `kind` equals `key`.
   */
  selectCover?<T extends MetadataSourceFile>(files: readonly T[]): T | null;

  /**
   * Optional: the source's cover files across a whole library, for the bulk cover-refresh path
   * (which reads persisted files rather than an in-memory scan list). Absent means this source
   * contributes nothing to bulk refresh.
   */
  listLibraryCovers?(libraryId: number): Promise<{ bookId: number; absolutePath: string; format: string | null }[]>;
}

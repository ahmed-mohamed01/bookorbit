import { basename } from 'node:path';

import { LIBRARY_METADATA_PRECEDENCE_DEFAULT } from '../../library/library.constants';

export type CoverReadSource = { kind: 'sidecar'; absolutePath: string } | { kind: 'embedded'; absolutePath: string; format: string };

export const SIDECAR_COVER_EXTENSION_PRIORITY = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'];

function coverFileStem(absolutePath: string): string {
  const name = basename(absolutePath);
  const index = name.lastIndexOf('.');
  return (index > 0 ? name.slice(0, index) : name).toLowerCase();
}

/**
 * Picks the winning sidecar cover from a set of a single book's files: basename
 * stem exactly `cover`, extension in the supported set, tie-broken by extension
 * priority. Mirrors the scan-time selection so refresh flows agree with scan.
 */
export function selectSidecarCoverPath(files: readonly { absolutePath: string; format: string | null }[]): string | null {
  let best: { absolutePath: string; rank: number } | null = null;
  for (const file of files) {
    if (file.format === null) continue;
    const rank = SIDECAR_COVER_EXTENSION_PRIORITY.indexOf(file.format);
    if (rank === -1) continue;
    if (coverFileStem(file.absolutePath) !== 'cover') continue;
    if (!best || rank < best.rank) best = { absolutePath: file.absolutePath, rank };
  }
  return best?.absolutePath ?? null;
}

/**
 * Groups batched `role='cover'` rows by book and resolves the winning sidecar
 * cover path per book. Lets refresh flows issue one batched query and resolve
 * every book's sidecar cover in memory (no per-book query).
 */
export function buildSidecarCoverPathByBookId(rows: readonly { bookId: number; absolutePath: string; format: string | null }[]): Map<number, string> {
  const grouped = new Map<number, { absolutePath: string; format: string | null }[]>();
  for (const row of rows) {
    const list = grouped.get(row.bookId);
    if (list) list.push(row);
    else grouped.set(row.bookId, [row]);
  }
  const result = new Map<number, string>();
  for (const [bookId, files] of grouped) {
    const path = selectSidecarCoverPath(files);
    if (path) result.set(bookId, path);
  }
  return result;
}

export interface CoverReadOrderInput {
  precedence: readonly string[] | null | undefined;
  primaryFile: { absolutePath: string; format: string | null } | null;
  sidecarCoverPath: string | null;
}

/**
 * Whether the sidecar cover source outranks the embedded one for the given
 * precedence list. Mirrors the scanner's precedence normalization for the
 * sidecar/embedded pair: when a source is missing from the configured list it
 * is treated as appended after the configured ones in scanner source order
 * (embedded before sidecar), so an absent entry always loses to a present one.
 */
export function sidecarCoverRanksAboveEmbedded(precedence: readonly string[] | null | undefined): boolean {
  const configured = precedence && precedence.length > 0 ? precedence : LIBRARY_METADATA_PRECEDENCE_DEFAULT;
  const sidecarIndex = configured.indexOf('sidecar');
  const embeddedIndex = configured.indexOf('embedded');
  if (sidecarIndex !== -1 && embeddedIndex !== -1) return sidecarIndex < embeddedIndex;
  if (sidecarIndex !== -1) return true;
  return false;
}

/**
 * Given the configured precedence and the available cover sources, returns the
 * cover sources to attempt in priority order. Shared by the scan path and the
 * refresh flows; each caller supplies its inputs differently and reads the
 * first source that yields cover bytes.
 */
export function resolveCoverReadOrder(input: CoverReadOrderInput): CoverReadSource[] {
  const sidecar: CoverReadSource | null = input.sidecarCoverPath ? { kind: 'sidecar', absolutePath: input.sidecarCoverPath } : null;
  const embedded: CoverReadSource | null =
    input.primaryFile && input.primaryFile.format
      ? { kind: 'embedded', absolutePath: input.primaryFile.absolutePath, format: input.primaryFile.format }
      : null;

  const order: CoverReadSource[] = [];
  if (sidecar && sidecarCoverRanksAboveEmbedded(input.precedence)) {
    order.push(sidecar);
    if (embedded) order.push(embedded);
  } else {
    if (embedded) order.push(embedded);
    if (sidecar) order.push(sidecar);
  }
  return order;
}

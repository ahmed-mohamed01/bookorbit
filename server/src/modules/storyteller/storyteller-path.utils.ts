import { posix } from 'path';
import { BadRequestException } from '@nestjs/common';

import type { StorytellerPathMapping } from '@bookorbit/types';

import { isMappablePathPrefix, normalizeMatchPath } from '../../common/utils/path-prefix-mapping.utils';
// Prefix rewriting is upstream's, reused rather than reimplemented - the same deliberate
// cross-module import `audiobookshelf-match.utils` makes. Re-point both if upstream moves the planner.
import { applyPathMappings, pathMatchesPrefix } from '../migration/planner/matching.service';
import type { PathMapping } from '../migration/planner/planner.types';

// Storyteller truncates a filename segment to 150 UTF-8 bytes including its suffix
// (`getSafeFilepathSegment` in `applications/web/src/assets/paths.ts`).
const SAFE_SEGMENT_BYTE_LIMIT = 150;

const READ_ALONG_SUFFIX = '.epub';

const ILLEGAL_FILENAME_CHARS = /[/\\:*?"<>|]/g;

/** A `BadRequestException` so the controller answers 400 untranslated, subclassed so callers can tell it apart. */
export class InvalidPathMappingError extends BadRequestException {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPathMappingError';
  }
}

/**
 * Canonical form for both directions, so `/books/` behaves as `/books`. Rows that could never
 * translate are dropped here so a legacy row cannot break a read, while the settings boundary
 * rejects them where there is someone to tell. Nesting is deliberately not dropped: the boundary
 * refuses new nested sets, and dropping one silently would stop paths that currently translate.
 */
export function normalizePathMappings(mappings: readonly StorytellerPathMapping[] | null | undefined): StorytellerPathMapping[] {
  const normalized: StorytellerPathMapping[] = [];
  const seenLocal = new Set<string>();
  const seenRemote = new Set<string>();
  for (const mapping of mappings ?? []) {
    const localPrefix = normalizeMatchPath(mapping?.localPrefix);
    const remotePrefix = normalizeMatchPath(mapping?.remotePrefix);
    if (!localPrefix || !remotePrefix) continue;
    if (!isUsablePrefix(localPrefix) || !isUsablePrefix(remotePrefix)) continue;
    if (seenLocal.has(localPrefix) || seenRemote.has(remotePrefix)) continue;
    seenLocal.add(localPrefix);
    seenRemote.add(remotePrefix);
    normalized.push({ localPrefix, remotePrefix });
  }
  return normalized;
}

/**
 * Every way a mapping set can be unusable, told rather than silently dropped. A repeated prefix on
 * either side leaves its author believing a rewrite is configured that can never win the
 * longest-prefix contest.
 *
 * A prefix that *nests* inside another on the same side is rejected for a sharper reason: each
 * direction picks its own longest match, so the pair stops being invertible. With `/a <-> /x` and
 * `/b <-> /x/sub`, `/a/sub/c` maps out to `/x/sub/c` and back to `/b/c`.
 */
export function assertMappablePathMappings(mappings: readonly StorytellerPathMapping[] | null | undefined): void {
  const seenLocal = new Set<string>();
  const seenRemote = new Set<string>();

  for (const mapping of mappings ?? []) {
    const localPrefix = normalizeMatchPath(mapping?.localPrefix);
    const remotePrefix = normalizeMatchPath(mapping?.remotePrefix);
    if (!localPrefix || !remotePrefix || !isMappablePathPrefix(localPrefix) || !isMappablePathPrefix(remotePrefix)) {
      throw new InvalidPathMappingError('Path prefix must contain at least one folder segment');
    }
    if (!localPrefix.startsWith('/') || !remotePrefix.startsWith('/')) {
      throw new InvalidPathMappingError('Path prefix must be absolute');
    }
    if (seenLocal.has(localPrefix)) {
      throw new InvalidPathMappingError('Each BookOrbit path prefix can only be mapped once');
    }
    if (seenRemote.has(remotePrefix)) {
      throw new InvalidPathMappingError('Each Storyteller path prefix can only be mapped once');
    }
    if (nestsInAny(localPrefix, seenLocal)) {
      throw new InvalidPathMappingError('BookOrbit path prefixes cannot contain one another');
    }
    if (nestsInAny(remotePrefix, seenRemote)) {
      throw new InvalidPathMappingError('Storyteller path prefixes cannot contain one another');
    }
    seenLocal.add(localPrefix);
    seenRemote.add(remotePrefix);
  }
}

/** The path the Storyteller server sees for a BookOrbit path, or null when no mapping covers it. */
export function toRemotePath(localPath: string | null | undefined, mappings: readonly StorytellerPathMapping[] | null | undefined): string | null {
  return translate(localPath, toPrefixMappings(mappings, 'toRemote'));
}

/** The BookOrbit path for a path the Storyteller server reported, or null when no mapping covers it. */
export function toLocalPath(remotePath: string | null | undefined, mappings: readonly StorytellerPathMapping[] | null | undefined): string | null {
  return translate(remotePath, toPrefixMappings(mappings, 'toLocal'));
}

/** Port of Storyteller's `getSafeFilepathSegment`, plus the leading-dot divergence `sanitizeFilename` explains. */
export function storytellerSafeFilepathSegment(name: string, suffix = ''): string {
  return truncateToByteLimit(sanitizeFilename(name), SAFE_SEGMENT_BYTE_LIMIT, suffix);
}

/**
 * Where a `CUSTOM_FOLDER` Storyteller writes a reference-imported book's read-along: the configured
 * folder plus the sanitized title, flat, in Storyteller's own path space.
 */
export function expectedCustomFolderOutputPath(customFolderRemotePath: string | null | undefined, title: string): string | null {
  const folder = normalizeMatchPath(customFolderRemotePath);
  if (!folder) return null;
  // A title of nothing but illegal characters sanitizes away: `<folder>/.epub` is a hidden file
  // every such title would share, not this book's output.
  const segment = storytellerSafeFilepathSegment(title, READ_ALONG_SUFFIX);
  if (segment === READ_ALONG_SUFFIX) return null;
  return posix.join(folder, segment);
}

function isUsablePrefix(prefix: string): boolean {
  return isMappablePathPrefix(prefix) && prefix.startsWith('/');
}

// Containment in either direction: a duplicate is caught by the callers' own seen-set check first.
function nestsInAny(prefix: string, seen: ReadonlySet<string>): boolean {
  return [...seen].some((other) => pathMatchesPrefix(prefix, other) || pathMatchesPrefix(other, prefix));
}

function toPrefixMappings(mappings: readonly StorytellerPathMapping[] | null | undefined, direction: 'toRemote' | 'toLocal'): PathMapping[] {
  return normalizePathMappings(mappings).map((mapping) =>
    direction === 'toRemote'
      ? { sourcePrefix: mapping.localPrefix, targetPrefix: mapping.remotePrefix }
      : { sourcePrefix: mapping.remotePrefix, targetPrefix: mapping.localPrefix },
  );
}

/**
 * `applyPathMappings` hands back its input when nothing matches, so the covering prefix is checked
 * first: an untranslated path belongs to the other server and must not be used as if it were local.
 */
function translate(value: string | null | undefined, mappings: PathMapping[]): string | null {
  const normalized = normalizeMatchPath(value);
  if (!normalized || mappings.length === 0) return null;
  if (!mappings.some((mapping) => pathMatchesPrefix(normalized, mapping.sourcePrefix))) return null;
  return normalizeMatchPath(applyPathMappings(normalized, mappings));
}

// Leading dots are dropped, the one place this port deliberately diverges from Storyteller's
// sanitizer: every scanner walk skips dotfiles, so a title like `.hack` would land as a file no scan
// can index, and each retry would download it again.
function sanitizeFilename(title: string): string {
  return title
    .replace(ILLEGAL_FILENAME_CHARS, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.-]+$/, '')
    .replace(/^\.+/, '');
}

function truncateToByteLimit(input: string, byteLimit: number, suffix: string): string {
  const normalized = input.normalize('NFC');
  const encoder = new TextEncoder();
  let result = '';
  for (const char of normalized) {
    if (encoder.encode(result + char + suffix).length > byteLimit) break;
    result += char;
  }
  return result + suffix;
}

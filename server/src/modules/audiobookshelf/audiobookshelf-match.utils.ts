// ABS-specific matching helpers. Everything else the matcher needs (title/author similarity, ISBN
// normalization) is imported directly from upstream's hardcover-import.service so upstream fixes
// reach this fork without a copy to keep in sync.

import type { AudiobookshelfPathMapping } from '@bookorbit/types';

import { applyPathMappings, pathMatchesPrefix } from '../migration/planner/matching.service';
import type { PathMapping } from '../migration/planner/planner.types';

// Canonical ASIN form for ABS write boundaries and exact-match query inputs.
export function normalizeAsin(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toUpperCase();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Canonical form for path comparison: duplicate separators collapsed and a trailing separator
 * dropped, so `/books//Author/Title/` and `/books/Author/Title` compare equal. Deliberately
 * case-sensitive - the storage the two servers share is the same case-sensitive filesystem.
 */
export function normalizeMatchPath(value: string | null | undefined): string | null {
  if (!value) return null;
  const collapsed = value.trim().replace(/\/{2,}/g, '/');
  if (!collapsed) return null;
  const trimmed = collapsed.length > 1 && collapsed.endsWith('/') ? collapsed.slice(0, -1) : collapsed;
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * A prefix only means something as a mount root when it names at least one folder. `/` matches every
 * absolute path yet rewrites nothing (upstream's `applyPathMappings` normalizes it away), so a
 * mapping rooted there would claim paths it cannot translate and hand the raw ABS path to the lookup.
 */
export function isMappablePathPrefix(value: string | null | undefined): boolean {
  const normalized = normalizeMatchPath(value);
  return normalized !== null && normalized !== '/';
}

/**
 * Splits a path into its last two segments (the author/book folders both servers share) and the
 * mount prefix above them. Two segments are the anchor because the folder structure below a library
 * root is identical on both sides, so equal keys name the same book on disk. Returns null for a path
 * that has no room for a prefix above such a key (a relative path, or one only two segments deep).
 */
export function splitPathSuffixKey(value: string | null | undefined): { key: string; prefix: string } | null {
  const normalized = normalizeMatchPath(value);
  if (!normalized || !normalized.startsWith('/')) return null;
  const segments = normalized.split('/');
  if (segments.length < 3) return null;
  const key = segments.slice(-2).join('/');
  const prefix = normalizeMatchPath(segments.slice(0, -2).join('/') || '/');
  if (!key || !prefix) return null;
  return { key, prefix };
}

/**
 * Extends a suffix-anchored pair by absorbing every further trailing segment the two prefixes share
 * (author and series folders live on both sides), so votes land on the diverging mount roots rather
 * than on per-author subfolders.
 */
export function stripSharedTrailingSegments(absPrefix: string, localPrefix: string): { absPrefix: string; localPrefix: string } {
  const abs = absPrefix.split('/');
  const local = localPrefix.split('/');
  while (abs.length > 2 && local.length > 2 && abs[abs.length - 1] !== '' && abs[abs.length - 1] === local[local.length - 1]) {
    abs.pop();
    local.pop();
  }
  return {
    absPrefix: normalizeMatchPath(abs.join('/') || '/') ?? absPrefix,
    localPrefix: normalizeMatchPath(local.join('/') || '/') ?? localPrefix,
  };
}

/**
 * User-configured ABS -> BookOrbit prefix rewrites in the shape upstream's planner helpers expect.
 * Rows whose either side does not name a folder are dropped: `applyPathMappings` skips them and hands
 * back the untranslated path, which the caller would then probe as if it were a BookOrbit path.
 */
export function toPlannerPathMappings(mappings: readonly AudiobookshelfPathMapping[] | null | undefined): PathMapping[] {
  const planner: PathMapping[] = [];
  for (const mapping of mappings ?? []) {
    const sourcePrefix = normalizeMatchPath(mapping.absPrefix);
    const targetPrefix = normalizeMatchPath(mapping.localPrefix);
    if (!sourcePrefix || !targetPrefix) continue;
    if (!isMappablePathPrefix(sourcePrefix) || !isMappablePathPrefix(targetPrefix)) continue;
    planner.push({ sourcePrefix, targetPrefix });
  }
  return planner;
}

/**
 * The BookOrbit absolute path an ABS item path rewrites to, or null when no configured mapping
 * covers it. `applyPathMappings` returns its input unchanged in that case, so the covering prefix is
 * checked first: an unmapped ABS path is not a BookOrbit path and must not reach the lookup.
 * Longest-prefix-wins ordering comes from `applyPathMappings` itself.
 *
 * Only a mapping `applyPathMappings` would actually apply counts as covering, so a row it silently
 * skips can never let the raw ABS path through as if it had been translated.
 */
export function mapAbsItemPath(absPath: string | null | undefined, mappings: readonly PathMapping[]): string | null {
  const normalized = normalizeMatchPath(absPath);
  if (!normalized || mappings.length === 0) return null;
  const covered = mappings.some(
    (mapping) =>
      isMappablePathPrefix(mapping.sourcePrefix) && isMappablePathPrefix(mapping.targetPrefix) && pathMatchesPrefix(normalized, mapping.sourcePrefix),
  );
  if (!covered) return null;
  return normalizeMatchPath(applyPathMappings(normalized, [...mappings]));
}

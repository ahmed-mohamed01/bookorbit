/**
 * Canonical path form for prefix rewriting between two servers that see the same storage under
 * different mount roots.
 *
 * The rewriting itself is upstream's: `storyteller-path.util` calls `applyPathMappings` /
 * `pathMatchesPrefix` from `modules/migration/planner/matching.service` directly, the same
 * deliberate reuse `audiobookshelf-match.utils` makes (FORK_MAINTENANCE, "Watched cross-module
 * import"). Only the canonicalization below is fork-owned, because upstream has no equivalent.
 *
 * `audiobookshelf-match.utils` still carries its own `normalizeMatchPath` / `isMappablePathPrefix`.
 * They are no longer the same function: this one resolves `.` and `..` (see below) and the ABS one
 * deliberately does not, because changing how ABS canonicalizes would shift the keys its stored
 * path-mapping votes are matched on. Do not "deduplicate" them back together without re-reconciling
 * that; importing ABS's copy from here would also make Storyteller depend on the ABS module, which
 * plugin isolation forbids.
 */

/**
 * Canonical form for path comparison: duplicate separators collapsed, `.`/`..` resolved, and a
 * trailing separator dropped, so `/books//Author/Title/` and `/books/Author/Title` compare equal.
 * Deliberately case-sensitive - the storage the two servers share is the same case-sensitive
 * filesystem.
 *
 * Traversal segments are resolved rather than merely tolerated: a mapped path is handed to
 * containment checks (`startsWith` against a library folder), and `/mnt/ra/../../elsewhere/x.epub`
 * would otherwise pass one while naming a file outside the folder entirely.
 */
export function normalizeMatchPath(value: string | null | undefined): string | null {
  if (!value) return null;
  const collapsed = resolveTraversal(value.trim().replace(/\/{2,}/g, '/'));
  if (!collapsed) return null;
  const trimmed = collapsed.length > 1 && collapsed.endsWith('/') ? collapsed.slice(0, -1) : collapsed;
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * A prefix only means something as a mount root when it names at least one folder. `/` matches
 * every absolute path yet rewrites nothing, so a mapping rooted there would claim paths it cannot
 * translate and hand the untranslated path to the caller.
 */
export function isMappablePathPrefix(value: string | null | undefined): boolean {
  const normalized = normalizeMatchPath(value);
  return normalized !== null && normalized !== '/';
}

/**
 * `posix.normalize` in the two respects that matter here: `.` segments drop out and `..` pops the
 * segment before it, clamped at the root for an absolute path. Written out rather than delegated to
 * `path` so these are always compared as the posix paths both servers report, whatever the platform
 * `path` resolves to.
 */
function resolveTraversal(value: string): string {
  if (!value.includes('.')) return value;

  const isAbsolute = value.startsWith('/');
  const hadTrailingSeparator = value.length > 1 && value.endsWith('/');
  const resolved: string[] = [];

  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment !== '..') {
      resolved.push(segment);
      continue;
    }
    const previous = resolved[resolved.length - 1];
    if (previous !== undefined && previous !== '..') resolved.pop();
    else if (!isAbsolute) resolved.push('..');
  }

  const joined = resolved.join('/');
  if (isAbsolute) return `/${joined}`;
  return hadTrailingSeparator && joined.length > 0 ? `${joined}/` : joined;
}

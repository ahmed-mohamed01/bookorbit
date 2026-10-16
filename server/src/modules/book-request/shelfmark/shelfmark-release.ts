import { createHash } from 'crypto';
import type { BookRequestMediaKind } from '@bookorbit/types';

/**
 * Shelfmark's release sources, as its `/api/release-sources` names them. Prowlarr and Newznab are
 * left out on purpose: BookOrbit talks to those directly, so searching them again through Shelfmark
 * would only list every release twice.
 */
export const SHELFMARK_SOURCES = ['direct_download', 'libgen', 'audiobookbay', 'irc'] as const;
export type ShelfmarkSource = (typeof SHELFMARK_SOURCES)[number];

/** Shelfmark's own display names, so a release says which site it came from. */
export const SHELFMARK_SOURCE_LABELS: Record<ShelfmarkSource, string> = {
  direct_download: "Anna's Archive",
  libgen: 'Library Genesis',
  audiobookbay: 'AudiobookBay',
  irc: 'IRC',
};

/** What each source's `supported_content_types` declares in Shelfmark; asking one for anything else only costs its timeout. */
export const SHELFMARK_SOURCE_MEDIA_KINDS: Record<ShelfmarkSource, readonly BookRequestMediaKind[]> = {
  direct_download: ['ebook'],
  libgen: ['ebook'],
  audiobookbay: ['audiobook'],
  irc: ['ebook', 'audiobook'],
};

export function shelfmarkSourceCarries(source: string, mediaKind: BookRequestMediaKind): boolean {
  return SHELFMARK_SOURCE_MEDIA_KINDS[source as ShelfmarkSource]?.includes(mediaKind) ?? false;
}

const URL_IN_TEXT = /https?:\/\/[^\s"'<>]+/gi;
const SECRET_ASSIGNMENT = /\b(key|api_?key|token|password|secret)=[^&\s"']+/gi;

/**
 * Shelfmark builds its status and error text from exceptions, and the URLs in them can carry the
 * Anna's Archive donator key, in the query and as a path segment of the fast download link. Only
 * a URL's origin survives, which still says which site failed.
 */
export function redactShelfmarkText(value: string): string {
  return value
    .replace(URL_IN_TEXT, (url) => {
      try {
        return new URL(url).origin;
      } catch {
        return '[link]';
      }
    })
    .replace(SECRET_ASSIGNMENT, '$1=[REDACTED]');
}

export function shelfmarkSourceLabel(source: string): string {
  return SHELFMARK_SOURCE_LABELS[source as ShelfmarkSource] ?? source;
}

/** The source a stored release guid names, which is everything before its first colon. */
export function shelfmarkOriginFromGuid(guid: string | null): string | undefined {
  const source = guid?.split(':', 1)[0];
  return source ? shelfmarkSourceLabel(source) : undefined;
}

export const DEFAULT_SHELFMARK_SOURCE: ShelfmarkSource = 'direct_download';

/**
 * A release exactly as Shelfmark's search returned it. Kept whole and handed back unchanged on a
 * grab, because what a source needs to download is source-specific (AudiobookBay's detail page,
 * IRC's bot and command) and lives in fields BookOrbit has no reason to understand.
 */
export type ShelfmarkRelease = Record<string, unknown> & { source: string; source_id: string };

/** Longer than any real release, short enough that one cannot become a payload. */
export const MAX_SHELFMARK_RELEASE_BYTES = 64 * 1024;

/**
 * Shelfmark names a queued download by the release's own `source_id`, which for some sources is a
 * URL and can outgrow the client key column. A digest fits it and is still recoverable, because a
 * status poll hashes each task id it sees and compares.
 */
export function shelfmarkClientKey(taskId: string): string {
  return createHash('sha1').update(`shelfmark:${taskId}`).digest('hex');
}

/** The guid a Shelfmark release carries in BookOrbit: unique across its sources, not just within one. */
export function shelfmarkReleaseGuid(release: ShelfmarkRelease): string {
  return `${release.source}:${release.source_id}`;
}

const SIZE_UNITS: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };

/** Shelfmark states sizes for display, such as "2.4MB" or "1,024.5 KB", and rarely as bytes. */
export function parseShelfmarkSize(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^([\d,]+(?:\.\d+)?)\s*([kmgt]?i?b)$/i.exec(value.trim());
  if (!match) return null;
  const unit = SIZE_UNITS[match[2]!.toLowerCase().replace('i', '')];
  const amount = Number(match[1]!.replace(/,/g, ''));
  return unit && Number.isFinite(amount) ? Math.round(amount * unit) : null;
}

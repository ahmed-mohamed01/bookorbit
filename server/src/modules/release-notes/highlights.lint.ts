import { extractHighlightsBlock, findExplicitMediaUrls, isAllowedImageHost, parseHighlightEntries } from './highlights.parser';
import { LUCIDE_ICON_NAMES } from './lucide-icon-names';
import { MAX_BODY_LENGTH, MAX_MEDIA_PER_HIGHLIGHT, MAX_TITLE_LENGTH } from './release-notes.constants';

const LEGACY_ICON_BULLET_RE = /^\s*[-*]\s+\[[A-Za-z][A-Za-z0-9]*\]/;

export interface HighlightsLintResult {
  errors: string[];
  warnings: string[];
  highlightCount: number;
}

/**
 * Validate the `## Highlights` text of a release body (static, no network), using the same
 * parser the app uses. Errors mean "the popup won't render correctly"; warnings are likely mistakes.
 */
export function lintHighlights(body: string | null | undefined): HighlightsLintResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const block = extractHighlightsBlock(body ?? '');
  if (block === null) {
    errors.push('No "## Highlights" section found. Add a heading exactly like "## Highlights".');
    return { errors, warnings, highlightCount: 0 };
  }

  const entries = parseHighlightEntries(body);
  if (entries.length === 0) {
    errors.push('A "## Highlights" section exists but no valid bullets were parsed. Each highlight must be a line starting with "- ".');
  }

  for (const url of findExplicitMediaUrls(block.join('\n'))) {
    if (!isAllowedImageHost(url)) {
      warnings.push(
        `Media will be dropped (host not allowed): ${url}. Use a GitHub user-attachments or githubusercontent URL (drag-drop into the release).`,
      );
    }
  }

  if (block.some((line) => LEGACY_ICON_BULLET_RE.test(line))) {
    warnings.push(
      'A highlight uses the legacy "[Icon]" prefix, which renders as literal "[Icon]" text on the GitHub release page. Move the icon into a trailing comment instead, e.g. "- **Title** - body. <!-- icon: BookHeart -->".',
    );
  }

  entries.forEach(({ highlight: h, mediaCount }, i) => {
    const n = i + 1;
    if (h.icon && !LUCIDE_ICON_NAMES.has(h.icon)) {
      warnings.push(
        `Highlight ${n} icon "${h.icon}" is not a known lucide icon; it will fall back to the default Sparkles icon. Check the spelling/casing at lucide.dev/icons.`,
      );
    }
    if (/\[[A-Za-z][^\]]*\]/.test(h.title)) {
      warnings.push(`Highlight ${n} title contains an unrecognized "[...]" token: "${h.title}". Icon tokens must be PascalCase, e.g. [BookHeart].`);
    }
    if (!h.body.trim()) {
      warnings.push(`Highlight ${n} ("${h.title}") has a title but no description text after " - ".`);
    }
    if (h.title.length > MAX_TITLE_LENGTH) {
      warnings.push(
        `Highlight ${n} title is ${h.title.length} chars (cap ${MAX_TITLE_LENGTH}); it will be visually clamped in the popup. Consider shortening it.`,
      );
    }
    if (h.body.length > MAX_BODY_LENGTH) {
      warnings.push(
        `Highlight ${n} body is ${h.body.length} chars (cap ${MAX_BODY_LENGTH}); it will be visually clamped in the popup. Consider shortening it.`,
      );
    }
    if (mediaCount > MAX_MEDIA_PER_HIGHLIGHT) {
      warnings.push(`Highlight ${n} has ${mediaCount} media items; only the first ${MAX_MEDIA_PER_HIGHLIGHT} will render. Remove the extras.`);
    }
  });

  return { errors, warnings, highlightCount: entries.length };
}

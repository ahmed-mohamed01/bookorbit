import { escapeRegExp, WORD_EDGE } from '../../story-guides/pipeline/name-text';
import { isDictionaryTerm } from '../core/generic-terms';
import type { Sentence, VisibleTerm } from '../core/model';
import { createTokenizer } from '../core/term-extractor';
import { termKey, words } from '../core/text-utils';

/** A lowercase compound over this share of its last word's uses is a thing of its own ("coma slurry"), not that word described. */
const OWN_COMPOUND_SHARE = 1 / 3;

export function descriptiveEntries(terms: readonly VisibleTerm[]): Set<string> {
  const names = new Map<string, number>();
  const folded = new Set<string>();
  const byLength = terms
    .map(({ key, displayName, count }) => ({ key, displayName, count, parts: words(displayName) }))
    .sort((a, b) => a.parts.length - b.parts.length);
  for (const { key, displayName, count, parts } of byLength) {
    if (displayName === displayName.toLowerCase()) {
      const heads = [parts];
      // A generic head can follow the name of the creature being described.
      if (/^creatures?$/.test(parts.at(-1) ?? '')) heads.push(parts.slice(0, -1));
      const described = (head: string[]) =>
        head.some((_, start) => {
          if (start === 0 || !head.slice(0, start).every(isDictionaryTerm)) return false;
          const named = names.get(termKey(head.slice(start).join(' ')));
          return named !== undefined && count <= named * OWN_COMPOUND_SHARE;
        });
      if (heads.some(described)) {
        folded.add(key);
        continue;
      }
    }
    names.set(termKey(displayName), count);
  }
  return folded;
}

const COMPARISON =
  /(?:^\s*like|\b(?:like\s+(?:a|an|the)|(?:more|just|look(?:s|ed)?|sound(?:s|ed)?|move(?:s|d)?)\s+like|as\s+(?:if|though)\b[^,;:.!?]*|(?:a|an)\s+real|some\s+kind\s+of(?:\s+(?:a|an))?))\s*$/iu;
const LIKE_SUFFIX = /^\s*[-\u2010-\u2013]\s*like\b/iu;
const QUOTED = /“[^“”]*(?:”|$)|"[^"]*(?:"|$)|‘[^‘’]*(?:’|$)/gu;
const VOCATIVE_END = /^\s*(?:[,.:!?“”"‘’]|$)/u;
const SPEAKER_BEFORE = /[”"’][,\s]*\b(?:said|asked|replied|whispered|shouted|answered|muttered|called|cried)\s*$/iu;
const UNREAL = /\b(?:would|could|might)\b/iu;
const OBJECT_BEFORE = /\b(?:saw|sees|watched|watches|heard|hears|let|lets|made|makes)\s*$/iu;
const APPOSITIVE = /^\s*,[^,.!?;]+,(?!\s*then\b)\s*/iu;

export function fictionNameCheck(sentences: readonly Sentence[]): (term: VisibleTerm) => boolean {
  let tokenize: ReturnType<typeof createTokenizer> | undefined;
  return (term) => {
    const body = term.mentions.filter(({ ordinal }) => sentences[ordinal - 1]?.structure === 'body');
    const oneOff = body.length === 1;
    const aliases = [...new Set(body.map(({ alias }) => alias))].sort((a, b) => b.length - a.length);
    if (!aliases.length) return false;
    const names = new RegExp(`${WORD_EDGE}(?:${aliases.map(escapeRegExp).join('|')})${WORD_EDGE}`, 'giu');
    for (const ordinal of new Set(body.map((mention) => mention.ordinal))) {
      const { text } = sentences[ordinal - 1];
      const quotes = [...text.matchAll(QUOTED)];
      for (const match of text.matchAll(names)) {
        const before = text.slice(0, match.index);
        const after = text.slice(match.index + match[0].length);
        if (COMPARISON.test(before) || LIKE_SUFFIX.test(after)) continue;
        const quote = quotes.find(({ index, 0: span }) => match.index > index && match.index < index + span.length);
        if (quote && VOCATIVE_END.test(after) && (before.trimEnd().endsWith(',') || match.index === quote.index + 1)) continue;
        if (!oneOff) return true;
        if (quote) continue;
        if (SPEAKER_BEFORE.test(before)) return true;
        if (OBJECT_BEFORE.test(before)) continue;
        const end = match.index + match[0].length + (after.match(APPOSITIVE)?.[0].length ?? 0);
        let offset = 0;
        const verb = (tokenize ??= createTokenizer())(text).find(({ value, pos }) => {
          const start = text.indexOf(value, offset);
          if (start < 0) return false;
          offset = start + value.length;
          return start >= end && pos !== 'ADV';
        });
        if (verb && ['VERB', 'AUX'].includes(verb.pos) && !UNREAL.test(verb.normal) && !verb.normal.endsWith('ing')) return true;
      }
    }
    return false;
  };
}

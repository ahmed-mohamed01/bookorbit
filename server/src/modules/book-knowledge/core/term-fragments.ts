import type { VisibleTerm } from './model';
import { words } from './text-utils';

type TermName = Pick<VisibleTerm, 'key' | 'displayName' | 'mentions'>;

const SMALL_WORDS = new Set(['of', 'the', 'and', 'in', 'on', 'to', 'a', 'an']);

function isProperName(name: string): boolean {
  return name.split(/\s+/).every((word) => /^\p{Lu}/u.test(word) || SMALL_WORDS.has(word));
}

export function termFragments(candidates: readonly TermName[], terms: readonly TermName[], properNamesOnly = true): Set<string> {
  const byFirstWord = new Map<string, { term: TermName; parts: string[] }[]>();
  for (const term of candidates) {
    const parts = words(term.displayName);
    if (!parts.length) continue;
    const first = parts[0];
    const matches = byFirstWord.get(first) ?? [];
    matches.push({ term, parts });
    byFirstWord.set(first, matches);
  }

  const fragments = new Set<string>();
  for (const longer of terms) {
    // "brother Damien" is a role word before a name, so the name is not a fragment of it.
    if (properNamesOnly && !isProperName(longer.displayName)) continue;
    const parts = words(longer.displayName);
    let ordinals: Set<number> | undefined;
    for (const [index, word] of parts.entries()) {
      for (const { term, parts: name } of byFirstWord.get(word) ?? []) {
        if (fragments.has(term.key) || name.length >= parts.length || !name.every((part, offset) => part === parts[index + offset])) continue;
        const containingOrdinals = (ordinals ??= new Set(longer.mentions.map(({ ordinal }) => ordinal)));
        if (term.mentions.every(({ ordinal }) => containingOrdinals.has(ordinal))) fragments.add(term.key);
      }
    }
  }
  return fragments;
}

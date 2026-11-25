import type { Artifact, VisibleTerm } from './core/model';
import { visibleTerms } from './core/artifact';
export const tokens = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

export function namedTerms(artifact: Artifact, cutoff: number, question: string): VisibleTerm[] {
  const questionText = ` ${tokens(question).join(' ')} `;
  const matched = visibleTerms(artifact, cutoff)
    .flatMap((term) => {
      const aliases = new Set([term.key, term.displayName, ...term.aliases, ...term.mentions.map((m) => m.alias)]);
      return [...aliases].flatMap((alias) => {
        const text = ` ${tokens(alias).join(' ')} `;
        const matches: { term: typeof term; start: number; end: number }[] = [];
        let start = questionText.indexOf(text);
        while (start >= 0) {
          matches.push({ term, start: start + 1, end: start + text.length - 1 });
          start = questionText.indexOf(text, start + 1);
        }
        return matches;
      });
    })
    .sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  const occupied: { start: number; end: number }[] = [];
  const named: { term: (typeof matched)[number]['term'] }[] = [];
  for (const match of matched) {
    if (occupied.some((prior) => match.start < prior.end && prior.start < match.end)) continue;
    occupied.push(match);
    if (!named.some((entry) => entry.term.key === match.term.key)) named.push({ term: match.term });
  }
  return named.map(({ term }) => term);
}

const prefixes = [
  'who is',
  'who was',
  'who are',
  'who were',
  'whos',
  'who s',
  'what is',
  'what was',
  'what are',
  'what were',
  'whats',
  'what s',
  'tell me about',
  'what does',
  'what do',
  'explain',
  'define',
  'describe',
  'remind me who',
  'remind me what',
]
  .map(tokens)
  .sort((a, b) => b.length - a.length);

function stripForm(words: string[], forms: string[][], trailing = false): string[] {
  for (const form of forms) {
    const start = trailing ? words.length - form.length : 0;
    if (start >= 0 && form.every((word, index) => words[start + index] === word)) return trailing ? words.slice(0, start) : words.slice(form.length);
  }
  return words;
}

export function termQuestion(artifact: Artifact, cutoff: number, question: string): string | null {
  let words = stripForm(tokens(question), prefixes);
  words = stripForm(words, [['the'], ['a'], ['an']]);
  words = stripForm(words, ['mean', 'means', 'stand for'].map(tokens), true);
  words = stripForm(words, ['again', 'exactly', 'in this book', 'in the book'].map(tokens), true);
  if (!words.length) return null;
  const text = words.join(' ');
  const matched = visibleTerms(artifact, cutoff).filter((term) =>
    [term.key, term.displayName, ...term.aliases, ...term.mentions.map((mention) => mention.alias)].some((alias) => tokens(alias).join(' ') === text),
  );
  return matched.length === 1 ? matched[0].key : null;
}

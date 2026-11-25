import type { Artifact } from './model';
import { termKey } from './text-utils';

const PAGE = String.raw`\d{1,4}(?:n\d{0,3})?(?:\s*[-\u2013\u2014]\s*\d{1,4}(?:n\d{0,3})?)?`;
const PAGE_LIST = new RegExp(String.raw`,\s*${PAGE}(?:\s*,\s*${PAGE})*(?=$|[\s,.;])`, 'gu');
// Without a leading comma only a trailing, comma-joined run is a page list, so "Area 51 12" keeps its 51.
const TRAILING_PAGES = new RegExp(String.raw`(?:[\s,]+|(?<=[\p{L}).!]))${PAGE}(?:\s*[,.]\s*${PAGE})*[\s,.;]*$`, 'u');
const SEE = /(?:^|[\s.,;])see(?: also)?\s+([^.;\n]+)/i;
const EDGE_WORD = /^(?:a|an|and|as|at|by|for|from|in|of|on|or|the|to|versus|vs|with)$/;
const MIN_ENTRIES = 20;
const cache = new WeakMap<Artifact, Set<string>>();

function parseSeed(seed: string): Set<string> {
  const headings = new Set<string>();
  let entries = 0;
  const add = (heading: string): void => {
    const name = heading
      .trim()
      .replace(/^Index\s+/i, '')
      .split(/,|\s+\(/, 1)[0];
    // Sub-entry fragments ("Ethics of", "Learning & exploration") are not names on their own.
    if (/[&+/]/.test(name)) return;
    const key = termKey(name);
    const parts = key.split(' ');
    if (key && /\p{L}/u.test(key) && !EDGE_WORD.test(parts[0]) && !EDGE_WORD.test(parts.at(-1)!)) headings.add(key);
  };
  const lines = seed.split(/\r?\n/);
  const numbered = lines.filter((line) => /\d/.test(line)).length;
  const commaLed = lines.filter((line) => /^\D*,\s*\d/.test(line)).length;
  for (const line of lines) {
    let start = 0;
    if (commaLed * 2 >= numbered) {
      for (const pages of line.matchAll(PAGE_LIST)) {
        const heading = line.slice(start, pages.index).replace(/^[\s.;]+/, '');
        const see = SEE.exec(heading);
        add(see ? heading.slice(0, see.index) : heading);
        if (see) add(see[1]);
        if (/\p{L}/u.test(heading)) entries++;
        start = pages.index + pages[0].length;
      }
    }
    const trailing = line.slice(start);
    const see = SEE.exec(trailing);
    const before = see ? trailing.slice(0, see.index) : trailing;
    const heading = before.replace(TRAILING_PAGES, '');
    if ((see || heading !== before) && /\p{L}/u.test(heading)) {
      add(heading);
      if (see) add(see[1]);
      entries++;
    }
  }
  return entries >= MIN_ENTRIES ? headings : new Set();
}

export function bookIndex(artifact: Artifact): ReadonlySet<string> {
  const cached = cache.get(artifact);
  if (cached) return cached;
  const headings = new Set(artifact.seeds.flatMap((seed) => [...parseSeed(seed)]));
  cache.set(artifact, headings);
  return headings;
}

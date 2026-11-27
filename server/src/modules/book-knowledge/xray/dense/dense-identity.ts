import { escapeRegExp, WORD_CHAR } from '../../../story-guides/pipeline/name-text';
import type { Sentence } from '../../core/model';
import type { XrayEntity } from '../xray-entities';
import { namedFirst, RANKS, type PassCast } from '../pass/pass-cast';

export type IdentityRule = 'vocative' | 'apposition' | 'title' | 'naming' | 'screen' | 'abbreviation';

export interface IdentityEvidence {
  a: XrayEntity;
  b: XrayEntity;
  rule: IdentityRule;
  ordinal: number;
}

export interface IdentityMerge {
  member: XrayEntity;
  head: XrayEntity;
  ordinal: number;
  /** The rules and sentences that joined the pair, for the run's merge log. */
  reason: string;
}

/** A pair needs this many sentences of evidence before code joins it; one is left to the alias ask. */
export const IDENTITY_SENTENCES = 2;

/** Nouns a book uses for many things at once: code never joins them to one name, whatever the text seems to say. */
export const IDENTITY_STOP = new Set(
  'golem golems dagger daggers empire empires palace palaces sled sleds cart carts revenant revenants zombie zombies outlander outlanders'.split(' '),
);

/** Whether `entity` is a generic noun from the stop list ("the Empire", "golems"), by its last word. */
export function stopListed(entity: XrayEntity): boolean {
  const last =
    entity.name
      .toLowerCase()
      .replace(/^the\s+/, '')
      .split(/\s+/)
      .at(-1) ?? '';
  return IDENTITY_STOP.has(last);
}

const QUOTE = /[“"]([^”"]*)[”"]?/g;
const ADDRESS = '(?:said|whispered|shouted|called|replied|answered|muttered|murmured|cried|added)\\s+to|told|asked';
/** `Viv, or the newly minted Princess Bob`, `was called`, `called herself`, `known as`, `real name`: not a bare "X called Y", which is a shout or a call. */
const NAMING =
  /,\s+or\s+(?:\S+\s+){0,4}$|\b(?:(?:(?:was|is|also)\s+called|called\s+(?:herself|himself|themselves|itself))|known as|real name(?:\s+(?:is|was))?)\s+(?:the\s+)?$/i;
const SCREEN_NAME = /(?:^|[[\s|])Name\s*:\s*$/;
/** A short form in capitals ("LN", "IRs"), as a book writes it in brackets after the name it shortens. */
const ABBREVIATION = /^\p{Lu}[\p{Lu}\p{N}]{1,5}s?$/u;

interface Spot {
  entity: XrayEntity;
  start: number;
  end: number;
}

/** Each entity's names, longest first, as patterns that match whole words; lowercase names ignore case. */
function namePatterns(entity: XrayEntity): RegExp[] {
  const names = [...new Set([entity.name, ...entity.names.map(({ text }) => text)])].filter((name) => name.length > 1);
  return names
    .sort((a, b) => b.length - a.length)
    .map((name) => new RegExp(`(?<!${WORD_CHAR})${escapeRegExp(name)}(?!${WORD_CHAR})`, /^\p{Lu}/u.test(name) ? 'gu' : 'giu'));
}

/** Where each named entity sits in a sentence; a shorter name inside a longer one's span is dropped. */
function spots(text: string, entities: readonly XrayEntity[], patterns: Map<XrayEntity, RegExp[]>): Spot[] {
  const found: Spot[] = [];
  for (const entity of entities)
    for (const pattern of patterns.get(entity)!)
      for (const match of text.matchAll(pattern)) found.push({ entity, start: match.index, end: match.index + match[0].length });
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  return found.filter(
    (spot, index) =>
      !found.some(
        (other, at) => at !== index && other.start <= spot.start && other.end >= spot.end && other.end - other.start > spot.end - spot.start,
      ),
  );
}

/**
 * Sentences where the text says two names are one: a vocative in a quote with the addressee named in the attribution
 * (`"Yes, Captain," Ash told Viv.`), an apposition (`Viv, the medic,`) or a title word before a character (`Princess Bob`), a
 * naming (`Bob, or Robert as`, `was called Robert`, `known as`, `real name`), and a status screen's `Name:` beside one
 * other character. Only sentences naming two entities are read. A descriptor or title set beside more than one
 * name is a shared word, not an identity, and gives no evidence.
 */
export function identityEvidence(entities: readonly XrayEntity[], sentences: readonly Sentence[]): IdentityEvidence[] {
  const usable = entities.filter((entity) => !stopListed(entity));
  const named = new Map<number, XrayEntity[]>();
  for (const entity of usable) for (const ordinal of entity.ordinals) named.set(ordinal, [...(named.get(ordinal) ?? []), entity]);
  const patterns = new Map(usable.map((entity) => [entity, namePatterns(entity)]));
  const evidence: IdentityEvidence[] = [];
  const beside = new Map<XrayEntity, Set<XrayEntity>>();
  const besideFound: IdentityEvidence[] = [];
  const add = (a: XrayEntity, b: XrayEntity, rule: IdentityRule, ordinal: number) => {
    if (a !== b) evidence.push({ a, b, rule, ordinal });
  };
  for (const [ordinal, present] of named) {
    if (present.length < 2) continue;
    const text = sentences[ordinal - 1]?.text ?? '';
    const found = spots(text, present, patterns);
    const quotes = [...text.matchAll(QUOTE)].map((match) => ({ start: match.index, end: match.index + match[0].length }));
    const inQuote = (spot: Spot) => quotes.some((quote) => spot.start > quote.start && spot.end < quote.end);

    for (const spot of found.filter(inQuote)) {
      const before = text.slice(0, spot.start);
      const after = text.slice(spot.end);
      if (!/(?:[“"]|,)\s*$/.test(before) || !/^\s*[,.!?]/.test(after)) continue;
      for (const other of found)
        if (!inQuote(other) && other.entity !== spot.entity && new RegExp(`\\b(?:${ADDRESS})\\s+$`, 'i').test(text.slice(0, other.start)))
          add(spot.entity, other.entity, 'vocative', ordinal);
    }

    for (const [index, spot] of found.entries()) {
      const next = found[index + 1];
      if (!next || inQuote(spot)) continue;
      const between = text.slice(spot.end, next.start);
      if (/^,\s+the\s+$/i.test(between) && /^\s*[,.;]/.test(text.slice(next.end))) {
        besideFound.push({ a: spot.entity, b: next.entity, rule: 'apposition', ordinal });
        beside.set(next.entity, (beside.get(next.entity) ?? new Set()).add(spot.entity));
      } else if (
        between === ' ' &&
        /^\p{Lu}/u.test(text.slice(spot.start)) &&
        RANKS.has(text.slice(spot.start, spot.end).split(/\s+/)[0].toLowerCase()) &&
        next.entity.kind === 'character'
      ) {
        besideFound.push({ a: next.entity, b: spot.entity, rule: 'title', ordinal });
        beside.set(spot.entity, (beside.get(spot.entity) ?? new Set()).add(next.entity));
      }
      // "the long name (LN)" or "LN (the long name)": a short form in brackets right after the name, or the reverse.
      if (
        /^\s*\($/.test(between) &&
        /^\)/.test(text.slice(next.end)) &&
        ABBREVIATION.test(text.slice(spot.start, spot.end)) !== ABBREVIATION.test(text.slice(next.start, next.end))
      )
        add(next.entity, spot.entity, 'abbreviation', ordinal);
      for (const later of found.slice(index + 1))
        if (NAMING.test(text.slice(spot.end, later.start)) && !/[.;:!?]/.test(text.slice(spot.end, later.start))) {
          add(spot.entity, later.entity, 'naming', ordinal);
          break;
        }
    }

    const screen = found.find((spot) => SCREEN_NAME.test(text.slice(0, spot.start)));
    const others = screen
      ? [...new Set(found.filter((spot) => spot.entity !== screen.entity && spot.entity.kind === 'character').map((spot) => spot.entity))]
      : [];
    if (screen && others.length === 1) add(screen.entity, others[0], 'screen', ordinal);
  }
  // "the medic" beside Viv and beside Pell is a role two people share.
  for (const item of besideFound) if ((beside.get(item.b)?.size ?? 0) === 1) evidence.push(item);
  return evidence;
}

/** Union-find over pairs with enough evidence; each component joins its busiest name, from the earliest sentence that shows it. */
export function identityMerges(
  cast: PassCast,
  sentences: readonly Sentence[],
  minimum = IDENTITY_SENTENCES,
): { merges: IdentityMerge[]; single: IdentityEvidence[] } {
  const byPair = new Map<string, IdentityEvidence[]>();
  for (const item of identityEvidence(cast.heads, sentences)) {
    const key = [item.a.key, item.b.key].sort().join('|');
    byPair.set(key, [...(byPair.get(key) ?? []), item]);
  }
  const parent = new Map<XrayEntity, XrayEntity>();
  const find = (entity: XrayEntity): XrayEntity => {
    const up = parent.get(entity);
    if (!up || up === entity) return entity;
    const root = find(up);
    parent.set(entity, root);
    return root;
  };
  const merges: IdentityMerge[] = [];
  const single: IdentityEvidence[] = [];
  const pairs = [...byPair.values()].sort((x, y) => Math.min(...x.map((e) => e.ordinal)) - Math.min(...y.map((e) => e.ordinal)));
  for (const items of pairs) {
    const ordinals = [...new Set(items.map((item) => item.ordinal))].sort((a, b) => a - b);
    if (ordinals.length < minimum) {
      // One sentence of a title before a name is too thin to spend an alias ask on.
      const shown = items.find((item) => item.rule !== 'title');
      if (shown) single.push(shown);
      continue;
    }
    const [x, y] = [find(items[0].a), find(items[0].b)];
    if (x === y) continue;
    const [member, head] = namedFirst(x, y, () => (x.count > y.count || (x.count === y.count && x.first < y.first) ? [y, x] : [x, y]));
    parent.set(member, head);
    const rules = [...new Set(items.map((item) => item.rule))].join('+');
    merges.push({ member, head, ordinal: Math.max(ordinals[0], member.first), reason: `${rules}@${ordinals.join(',')}` });
  }
  return { merges, single };
}

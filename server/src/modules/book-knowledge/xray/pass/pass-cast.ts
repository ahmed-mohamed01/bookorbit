import { escapeRegExp, FAMILY_AND_ROLE_WORDS, NAME_PREFIX_WORDS, TITLES } from '../../../story-guides/pipeline/name-text';
import type { Sentence } from '../../core/model';
import type { XrayEntity, XrayName } from '../xray-entities';
import { isJoinedPart } from '../xray-name-fold';
import type { PassUnit } from './pass-units';

export type PassMergeRule = 'full-name' | 'short-name' | 'title' | 'descriptor' | 'model' | 'alias' | 'narrator';

export const NARRATOR_ID = 'narrator';

export interface PassMerge {
  member: XrayEntity;
  head: XrayEntity;
  /** Where the text first makes the join plain; before it the member is its own entry. */
  ordinal: number;
  rule: PassMergeRule;
  /** Why the pair was a candidate, for an alias merge. */
  reason?: string;
}

export const RANKS = new Set([
  ...TITLES,
  ...NAME_PREFIX_WORDS,
  ...FAMILY_AND_ROLE_WORDS,
  ...'lieutenant corporal sergeant private major marshal admiral knight dame sir lady lord princess prince king queen captain commander'.split(' '),
]);
RANKS.delete('the');
const DESCRIPTOR_SHARE = 0.5;
/**
 * A short form shares few paragraphs with its full name (the one where both are given); two people in one scene ("Rob" and
 * his father "Robert") share many. Past this share of the short name's paragraphs, code leaves the pair to the alias ask.
 */
const SHORT_SHARE = 0.15;

const isPerson = (entity: XrayEntity) => entity.kind === 'character';
const isNameWord = (word: string) => /^\p{Lu}/u.test(word) && !RANKS.has(word.toLowerCase());
const words = (name: string) => name.split(/\s+/).filter(Boolean);

/** The one entity in `pool` named exactly `name`, or null when none or several are. */
function only(pool: readonly XrayEntity[], name: string, except: XrayEntity): XrayEntity | null {
  const found = pool.filter((entity) => entity !== except && entity.name === name);
  return found.length === 1 ? found[0] : null;
}

const allNames = (entity: XrayEntity) => [entity.name, ...entity.joins.map((join) => join.name)];
/** "Quill and Bram" is neither Quill nor Bram, so it never merges into one: that would chain the two together. */
const joinsEither = (a: XrayEntity, b: XrayEntity) => allNames(a).some((x) => allNames(b).some((y) => isJoinedPart(x, y) || isJoinedPart(y, x)));

/** A capitalised character ("Viv"), which a reader looks up by name. */
export const namedCharacter = (entity: XrayEntity) => entity.kind === 'character' && /^\p{Lu}/u.test(entity.name);

/**
 * Of two entities for one referent, the one a reader looks up heads it, whatever the counts: never the stand-in
 * Narrator; a capitalised character ("Viv", not "the medic" or a title the kinds step typed as an idea); then any
 * capitalised name over a lowercase word (Fort Stone, not "fort"); then the more important entry (the lead, not her
 * nickname). Otherwise `fallback` decides.
 */
export function namedFirst(
  a: XrayEntity,
  b: XrayEntity,
  fallback: (a: XrayEntity, b: XrayEntity) => [member: XrayEntity, head: XrayEntity],
): [member: XrayEntity, head: XrayEntity] {
  if ((a.id === NARRATOR_ID) !== (b.id === NARRATOR_ID)) return a.id === NARRATOR_ID ? [a, b] : [b, a];
  if (namedCharacter(a) !== namedCharacter(b)) return namedCharacter(a) ? [b, a] : [a, b];
  const capital = (entity: XrayEntity) => /^\p{Lu}/u.test(entity.name);
  if (capital(a) !== capital(b)) return capital(a) ? [b, a] : [a, b];
  if (a.importance !== b.importance) return a.importance < b.importance ? [b, a] : [a, b];
  return fallback(a, b);
}

/** Of two entities for one referent, the one with more mentions heads it. */
export function ordered(a: XrayEntity, b: XrayEntity): [member: XrayEntity, head: XrayEntity] {
  return a.count > b.count || (a.count === b.count && a.first < b.first) ? [b, a] : [a, b];
}

function paragraphOf(sentences: readonly Sentence[], ordinal: number): string {
  const sentence = sentences[ordinal - 1];
  return `${sentence.spineIndex}:${sentence.paragraphIndex}`;
}

function firstAtOrAfter(ordinals: readonly number[], ordinal: number): number {
  let first = 0;
  let last = ordinals.length;
  while (first < last) {
    const middle = Math.floor((first + last) / 2);
    if (ordinals[middle] < ordinal) first = middle + 1;
    else last = middle;
  }
  return first;
}

/**
 * Merges the text makes plain, found by pattern before any model call: a full name and its first or
 * last name (Eliezer Yudkowsky and Yudkowsky), a short form and the name it shortens when one
 * paragraph uses both (Viv and Viviane), a rank or title before a name (Lieutenant Cernit and Cernit),
 * and a lowercase descriptor set beside exactly one name ("Arthur, the dragonette"). Each takes effect
 * where the text first shows it. With `guard` (round 6), a full name joins its part only when every word
 * of it is a name, so a descriptor ("Kark woman", "Necrarch ravager") stays apart.
 */
export function patternMerges(entities: readonly XrayEntity[], sentences: readonly Sentence[], options: { guard?: boolean } = {}): PassMerge[] {
  const people = entities.filter(isPerson);
  const merges: PassMerge[] = [];
  const taken = new Set<XrayEntity>();
  const add = (a: XrayEntity, b: XrayEntity, ordinal: number, rule: PassMergeRule) => {
    if (taken.has(a) || taken.has(b)) return;
    const [member, head] = namedFirst(a, b, ordered);
    taken.add(member);
    merges.push({ member, head, ordinal, rule });
  };
  for (const full of people) {
    const parts = words(full.name);
    if (parts.length < 2) continue;
    const rank = RANKS.has(parts[0].toLowerCase()) ? only(people, parts.slice(1).join(' '), full) : null;
    if (rank) {
      add(full, rank, full.first, 'title');
      continue;
    }
    if (options.guard && !parts.every(isNameWord)) continue;
    for (const part of [parts[0], parts.at(-1)!]) {
      const short = only(people, part, full);
      const rivals = people.filter((other) => other !== full && words(other.name).length > 1 && words(other.name).includes(part));
      if (short && !rivals.length) add(short, full, Math.max(short.first, full.first), short.name === parts[0] ? 'short-name' : 'full-name');
    }
  }
  // A titled name the kind step typed as something else ("Princess Bob" as an idea) still names the one person after
  // the title; the person's kind wins. Sharing a paragraph keeps a ship or a pub named for someone apart.
  for (const titled of entities) {
    const parts = words(titled.name);
    if (isPerson(titled) || taken.has(titled) || parts.length < 2 || !/^\p{Lu}/u.test(titled.name) || !RANKS.has(parts[0].toLowerCase())) continue;
    const person = only(people, parts.slice(1).join(' '), titled);
    if (!person || taken.has(person)) continue;
    const paragraphs = new Set(person.ordinals.map((at) => paragraphOf(sentences, at)));
    if (!titled.ordinals.some((at) => paragraphs.has(paragraphOf(sentences, at)))) continue;
    taken.add(titled);
    merges.push({ member: titled, head: person, ordinal: titled.first, rule: 'title' });
  }
  for (const short of people) {
    if (words(short.name).length !== 1 || short.name.length < 3) continue;
    const longer = people.filter((other) => other !== short && words(other.name).length === 1 && other.name.startsWith(short.name));
    if (longer.length !== 1) continue;
    const other = longer[0];
    const own = new Map(short.ordinals.map((ordinal) => [paragraphOf(sentences, ordinal), ordinal]));
    const shared = new Set<string>();
    const both = other.ordinals.flatMap((ordinal) => {
      const mine = own.get(paragraphOf(sentences, ordinal));
      if (mine !== undefined) shared.add(paragraphOf(sentences, ordinal));
      return mine === undefined ? [] : [Math.max(mine, ordinal)];
    });
    if (both.length && shared.size <= Math.max(1, Math.floor(SHORT_SHARE * own.size))) add(short, other, Math.min(...both), 'short-name');
  }
  for (const descriptor of entities) {
    if (descriptor.name !== descriptor.name.toLowerCase() || descriptor.names.some((name) => /s$/.test(name.text) && name.text !== descriptor.name))
      continue;
    const pattern = new RegExp(`\\bthe\\s+${escapeRegExp(descriptor.name)}\\b`, 'i');
    const partners = new Map<XrayEntity, number>();
    for (const ordinal of descriptor.ordinals) {
      const text = sentences[ordinal - 1].text;
      if (!pattern.test(text)) continue;
      for (const person of people)
        if (person.name !== person.name.toLowerCase() && person.ordinals.includes(ordinal)) {
          const [who, what] = [escapeRegExp(person.name), escapeRegExp(descriptor.name)];
          const near = new RegExp(`${who}\\s*,\\s+the\\s+${what}|the\\s+${what}\\s*,\\s+${who}`, 'i');
          if (near.test(text) && !partners.has(person)) partners.set(person, ordinal);
        }
    }
    if (partners.size !== 1) continue;
    const [[person, ordinal]] = [...partners];
    const paragraphs = new Set(person.ordinals.map((at) => paragraphOf(sentences, at)));
    const shared = descriptor.ordinals.filter((at) => paragraphs.has(paragraphOf(sentences, at))).length;
    if (shared < DESCRIPTOR_SHARE * descriptor.ordinals.length) continue;
    if (taken.has(descriptor) || taken.has(person)) continue;
    taken.add(descriptor);
    merges.push({ member: descriptor, head: person, ordinal, rule: 'descriptor' });
  }
  return merges;
}

/** One cast-list entry the model sees for a unit: an entity, or a member whose join is still ahead. */
export interface PassSlot {
  id: string;
  /** The entity the payload keeps it under. */
  head: XrayEntity;
  /** Set when the slot is a member not yet joined at the unit's end: its data stays under the join. */
  member: XrayEntity | null;
  name: string;
  /** Other names a reader has seen by the unit's end. */
  aliases: string[];
  kind: XrayEntity['kind'];
  /** Sentences of the unit that name it. */
  mentions: number;
}

/**
 * The cast with its merges: heads keep the payload entries, members become joins. Before its join a
 * member is listed on its own, so nothing reveals the join early.
 */
export class PassCast {
  readonly heads: XrayEntity[];
  readonly merges: PassMerge[] = [];
  private readonly joinOf = new Map<XrayEntity, { head: XrayEntity; ordinal: number }>();
  private readonly byId: Map<string, XrayEntity>;
  /** Each entity's own sentences, before any merge adds its members'. */
  private readonly own: Map<XrayEntity, number[]>;

  private readonly narration = new Map<XrayEntity, number[]>();

  constructor(entities: readonly XrayEntity[]) {
    this.heads = [];
    this.byId = new Map();
    this.own = new Map();
    for (const entity of entities) this.add(entity);
  }

  add(entity: XrayEntity): void {
    this.heads.push(entity);
    this.byId.set(entity.id, entity);
    this.own.set(entity, entity.ordinals);
  }

  creditNarration(entity: XrayEntity, chunk: PassUnit, ordinals: readonly number[]): void {
    const slot = { id: entity.id, head: entity, member: null, name: entity.name, aliases: [], kind: entity.kind, mentions: 0 };
    const seen = new Set(this.mentionsOf(slot, chunk, chunk.ordinals));
    const fresh = ordinals.filter((ordinal) => !seen.has(ordinal));
    const credited = this.narration.get(entity) ?? [];
    for (const ordinal of fresh) credited.push(ordinal);
    this.narration.set(entity, credited);
    entity.count += fresh.length;
  }

  finishNarration(): void {
    const credited = new Map<XrayEntity, Set<number>>();
    for (const [entity, ordinals] of this.narration) {
      const head = this.headOf(entity);
      const all = credited.get(head) ?? new Set(head.ordinals);
      for (const ordinal of ordinals) all.add(ordinal);
      credited.set(head, all);
    }
    for (const [head, ordinals] of credited) head.ordinals = [...ordinals].sort((a, b) => a - b);
  }

  entity(id: string): XrayEntity | undefined {
    return this.byId.get(id);
  }

  /** The entity that keeps `entity` from `ordinal` on. */
  headOf(entity: XrayEntity, ordinal = Infinity): XrayEntity {
    const join = this.joinOf.get(entity);
    return join && join.ordinal <= ordinal ? this.headOf(join.head, ordinal) : entity;
  }

  joinedAt(entity: XrayEntity): number | null {
    return this.joinOf.get(entity)?.ordinal ?? null;
  }

  /** Where `entity` belongs to `target`: the latest join on the chain between them, -Infinity for itself, Infinity when it never does. */
  private reachAt(entity: XrayEntity, target: XrayEntity): number {
    let at = -Infinity;
    for (let current = entity; current !== target;) {
      const join = this.joinOf.get(current);
      if (!join) return Infinity;
      at = Math.max(at, join.ordinal);
      current = join.head;
    }
    return at;
  }

  /** Every entity that joins `entity` at some point, directly or through another member. */
  private membersOf(entity: XrayEntity): XrayEntity[] {
    return [...this.joinOf.keys()].filter((member) => this.reachAt(member, entity) !== Infinity);
  }

  /**
   * From where sentence `ordinal` counts as naming `entity`: at once when it names `entity` itself or a member already
   * joined, else from the member's join; Infinity when it names neither.
   */
  namedFrom(entity: XrayEntity, ordinal: number): number {
    let best = Infinity;
    for (const owner of [entity, ...this.membersOf(entity)]) {
      const own = this.own.get(owner) ?? owner.ordinals;
      if (own[firstAtOrAfter(own, ordinal)] !== ordinal) continue;
      best = Math.min(best, Math.max(ordinal, this.reachAt(owner, entity)));
    }
    return best;
  }

  /**
   * Joins `member` into `head`; false when they already share a head. The evidence ties the two names given, so their
   * final heads join only once each name has reached its own: a merge at 2000 onto a name that joins its head at 9000
   * takes effect at 9000, never earlier.
   */
  merge(merge: PassMerge): boolean {
    const [member, head] = namedFirst(this.headOf(merge.member), this.headOf(merge.head), (member, head) => [member, head]);
    if (head === member || joinsEither(member, head)) return false;
    const ordinal = Math.max(merge.ordinal, this.reachAt(merge.member, this.headOf(merge.member)), this.reachAt(merge.head, this.headOf(merge.head)));
    this.joinOf.set(member, { head, ordinal });
    const index = this.heads.indexOf(member);
    if (index >= 0) this.heads.splice(index, 1);
    head.joins.push(
      { key: member.key, name: member.name, names: member.names, ordinal },
      ...member.joins.map((join) => ({ ...join, ordinal: Math.max(join.ordinal, ordinal) })),
    );
    member.joins = [];
    head.ordinals = [...new Set([...head.ordinals, ...member.ordinals])].sort((a, b) => a - b);
    if (merge.rule === 'narrator') {
      const already = new Set(head.ordinals);
      head.count += (this.narration.get(member) ?? []).filter((ordinal) => !already.has(ordinal)).length;
    } else head.count += member.count;
    head.first = Math.min(head.first, member.first);
    this.merges.push({ ...merge, ordinal, head, member });
    return true;
  }

  /** Each head's sentences: its own, and each member's from the member's join on. */
  headMentions(): Map<XrayEntity, number[]> {
    const found = new Map<XrayEntity, Set<number>>(this.heads.map((head) => [head, new Set<number>()]));
    for (const [entity, ordinals] of this.own) for (const ordinal of ordinals) found.get(this.headOf(entity, ordinal))?.add(ordinal);
    for (const [entity, ordinals] of this.narration)
      for (const ordinal of ordinals) found.get(this.headOf(entity, entity.id === NARRATOR_ID ? Infinity : ordinal))?.add(ordinal);
    return new Map([...found].map(([head, ordinals]) => [head, [...ordinals].sort((a, b) => a - b)]));
  }

  /**
   * The sentences of `within` (by default, all up to the unit's end) that name a slot: its own, and for a
   * head its members joined by the unit's end.
   */
  mentionsOf(slot: PassSlot, unit: PassUnit, within?: readonly number[]): number[] {
    const end = unit.ordinals.at(-1)!;
    const listed = within ? new Set(within) : null;
    const wanted = (ordinal: number) => (listed ? listed.has(ordinal) : ordinal <= end);
    const from = within?.[0] ?? 0;
    const to = (within?.at(-1) ?? end) + 1;
    // A member belongs to whoever heads it at the unit's end, which for a member of a member may be that member.
    const self = slot.member ?? slot.head;
    const owners = [self, ...this.membersOf(self).filter((member) => this.headOf(member, end) === self)];
    return [
      ...new Set(
        owners.flatMap((owner) => [
          ...(this.own.get(owner) ?? owner.ordinals).filter(wanted),
          ...this.narrationBetween(owner, from, to).filter(wanted),
        ]),
      ),
    ].sort((a, b) => a - b);
  }

  private narrationBetween(entity: XrayEntity, from: number, to: number): number[] {
    const ordinals = this.narration.get(entity);
    return ordinals?.slice(firstAtOrAfter(ordinals, from), firstAtOrAfter(ordinals, to)) ?? [];
  }

  /**
   * The cast list for a unit: every entity or not-yet-joined member named in it, with names seen by its
   * end. `counted`, a stretch of the unit, narrows the list and the mention counts to that stretch.
   */
  slots(unit: PassUnit, counted: readonly number[] = unit.ordinals): PassSlot[] {
    const [start, stop] = [counted[0], counted.at(-1)!];
    const end = unit.ordinals.at(-1)!;
    const inRange = (ordinal: number) => ordinal >= start && ordinal <= stop;
    const within = (entity: XrayEntity) => {
      const narration = this.narration.get(entity);
      const credited = narration ? firstAtOrAfter(narration, stop + 1) - firstAtOrAfter(narration, start) : 0;
      return (this.own.get(entity) ?? entity.ordinals).filter(inRange).length + credited;
    };
    const named = (entity: XrayEntity) => within(entity) > 0;
    const seen = (names: readonly XrayName[]) => names.filter((name) => name.ordinal <= end).map((name) => name.text);
    const groups = new Map<XrayEntity, XrayEntity[]>();
    for (const member of this.joinOf.keys()) {
      const head = this.headOf(member);
      groups.set(head, [...(groups.get(head) ?? []), member]);
    }
    const slots: PassSlot[] = [];
    for (const head of this.heads) {
      const members = groups.get(head) ?? [];
      // Who keeps each member at the unit's end: the head, a member it joined first, or itself while its join is ahead.
      const keeper = new Map(members.map((member) => [member, this.headOf(member, end)]));
      const under = (owner: XrayEntity) => members.filter((member) => member !== owner && keeper.get(member) === owner);
      const slotOf = (owner: XrayEntity, member: XrayEntity | null): PassSlot | null => {
        const joined = under(owner);
        if (!named(owner) && !joined.some(named)) return null;
        const aliases = [
          ...new Set([...seen(owner.names), ...joined.filter((other) => other.id !== NARRATOR_ID).flatMap((other) => seen(other.names))]),
        ].filter((name) => name !== owner.name);
        const mentions = within(owner) + joined.reduce((sum, other) => sum + within(other), 0);
        return { id: owner.id, head, member, name: owner.name, aliases, kind: owner.kind, mentions };
      };
      const own = slotOf(head, null);
      if (own) slots.push(own);
      for (const member of members) {
        if (keeper.get(member) !== member) continue;
        const slot = slotOf(member, member);
        if (slot) slots.push(slot);
      }
    }
    return slots;
  }
}

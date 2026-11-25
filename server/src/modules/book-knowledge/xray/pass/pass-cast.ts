import { escapeRegExp, FAMILY_AND_ROLE_WORDS, NAME_PREFIX_WORDS, TITLES } from '../../../story-guides/pipeline/name-text';
import type { Sentence } from '../../core/model';
import type { XrayEntity, XrayName } from '../xray-entities';
import type { PassUnit } from './pass-units';

export type PassMergeRule = 'full-name' | 'short-name' | 'title' | 'descriptor' | 'model' | 'alias';

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

const isPerson = (entity: XrayEntity) => entity.kind === 'character';
const isNameWord = (word: string) => /^\p{Lu}/u.test(word) && !RANKS.has(word.toLowerCase());
const words = (name: string) => name.split(/\s+/).filter(Boolean);

/** The one entity in `pool` named exactly `name`, or null when none or several are. */
function only(pool: readonly XrayEntity[], name: string, except: XrayEntity): XrayEntity | null {
  const found = pool.filter((entity) => entity !== except && entity.name === name);
  return found.length === 1 ? found[0] : null;
}

/** A capitalised character ("Viv"), which a reader looks up by name. */
export const namedCharacter = (entity: XrayEntity) => entity.kind === 'character' && /^\p{Lu}/u.test(entity.name);

/**
 * Of two entities for one referent, a capitalised character heads it when exactly one of them is one ("Viv", not "the
 * medic" or a title the kinds step typed as an idea), whatever the counts; otherwise `fallback` decides.
 */
export function namedFirst(
  a: XrayEntity,
  b: XrayEntity,
  fallback: (a: XrayEntity, b: XrayEntity) => [member: XrayEntity, head: XrayEntity],
): [member: XrayEntity, head: XrayEntity] {
  if (namedCharacter(a) !== namedCharacter(b)) return namedCharacter(a) ? [b, a] : [a, b];
  return fallback(a, b);
}

/** Of two entities for one referent, the one with more mentions heads it. */
function ordered(a: XrayEntity, b: XrayEntity): [member: XrayEntity, head: XrayEntity] {
  return a.count > b.count || (a.count === b.count && a.first < b.first) ? [b, a] : [a, b];
}

function paragraphOf(sentences: readonly Sentence[], ordinal: number): string {
  const sentence = sentences[ordinal - 1];
  return `${sentence.spineIndex}:${sentence.paragraphIndex}`;
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
    const both = other.ordinals.flatMap((ordinal) => {
      const mine = own.get(paragraphOf(sentences, ordinal));
      return mine === undefined ? [] : [Math.max(mine, ordinal)];
    });
    if (both.length) add(short, other, Math.min(...both), 'short-name');
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

  constructor(entities: readonly XrayEntity[]) {
    this.heads = [...entities];
    this.byId = new Map(entities.map((entity) => [entity.id, entity]));
    this.own = new Map(entities.map((entity) => [entity, entity.ordinals]));
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

  /** Joins `member` into `head` from `ordinal` on; false when they already share a head. */
  merge(merge: PassMerge): boolean {
    const [member, head] = namedFirst(this.headOf(merge.member), this.headOf(merge.head), (member, head) => [member, head]);
    if (head === member) return false;
    this.joinOf.set(member, { head, ordinal: merge.ordinal });
    const index = this.heads.indexOf(member);
    if (index >= 0) this.heads.splice(index, 1);
    head.joins.push(
      { key: member.key, name: member.name, names: member.names, ordinal: merge.ordinal },
      ...member.joins.map((join) => ({ ...join, ordinal: Math.max(join.ordinal, merge.ordinal) })),
    );
    member.joins = [];
    head.ordinals = [...new Set([...head.ordinals, ...member.ordinals])].sort((a, b) => a - b);
    head.count += member.count;
    head.first = Math.min(head.first, member.first);
    this.merges.push({ ...merge, head, member });
    return true;
  }

  /** Each head's sentences: its own, and each member's from the member's join on. */
  headMentions(): Map<XrayEntity, number[]> {
    const found = new Map<XrayEntity, Set<number>>(this.heads.map((head) => [head, new Set<number>()]));
    for (const [entity, ordinals] of this.own) for (const ordinal of ordinals) found.get(this.headOf(entity, ordinal))?.add(ordinal);
    return new Map([...found].map(([head, ordinals]) => [head, [...ordinals].sort((a, b) => a - b)]));
  }

  /**
   * The sentences of `within` (by default, all up to the unit's end) that name a slot: its own, and for a
   * head its members joined by the unit's end.
   */
  mentionsOf(slot: PassSlot, unit: PassUnit, within?: readonly number[]): number[] {
    const end = unit.ordinals.at(-1)!;
    const listed = within ? new Set(within) : null;
    const wanted = { has: (ordinal: number) => (listed ? listed.has(ordinal) : ordinal <= end) };
    const owners = slot.member
      ? [slot.member]
      : [slot.head, ...[...this.joinOf].filter(([, join]) => this.headOf(join.head) === slot.head && join.ordinal <= end).map(([member]) => member)];
    return [...new Set(owners.flatMap((owner) => (this.own.get(owner) ?? owner.ordinals).filter((ordinal) => wanted.has(ordinal))))].sort(
      (a, b) => a - b,
    );
  }

  /**
   * The cast list for a unit: every entity or not-yet-joined member named in it, with names seen by its
   * end. `counted`, a stretch of the unit, narrows the list and the mention counts to that stretch.
   */
  slots(unit: PassUnit, counted: readonly number[] = unit.ordinals): PassSlot[] {
    const [start, stop] = [counted[0], counted.at(-1)!];
    const end = unit.ordinals.at(-1)!;
    const within = (entity: XrayEntity) => (this.own.get(entity) ?? entity.ordinals).filter((ordinal) => ordinal >= start && ordinal <= stop).length;
    const named = (entity: XrayEntity) => within(entity) > 0;
    const seen = (names: readonly XrayName[]) => names.filter((name) => name.ordinal <= end).map((name) => name.text);
    const slots: PassSlot[] = [];
    for (const head of this.heads) {
      const members = [...this.joinOf].filter(([, join]) => this.headOf(join.head) === head).map(([member]) => member);
      const joined = members.filter((member) => this.joinOf.get(member)!.ordinal <= end);
      if (named(head) || joined.some(named)) {
        const aliases = [...new Set([...seen(head.names), ...joined.flatMap((member) => seen(member.names))])].filter((name) => name !== head.name);
        const mentions = within(head) + joined.reduce((sum, member) => sum + within(member), 0);
        slots.push({ id: head.id, head, member: null, name: head.name, aliases, kind: head.kind, mentions });
      }
      for (const member of members)
        if (this.joinOf.get(member)!.ordinal > end && named(member))
          slots.push({
            id: member.id,
            head,
            member,
            name: member.name,
            aliases: seen(member.names).filter((name) => name !== member.name),
            kind: member.kind,
            mentions: within(member),
          });
    }
    return slots;
  }
}

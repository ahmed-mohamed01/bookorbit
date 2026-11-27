import type { StoryGuideChronicleAbilityGroup } from '@bookorbit/types';
import { namedLater, type LineNames } from '../../../story-guides/pipeline/lines-step';
import type { PassSlot } from './pass-cast';
import type { PassAnswer, PassFact, PassTie } from './pass-read';
import type { PassUnit } from './pass-units';

export const ABOUT_WORDS = 60;

export interface Stamped<T> {
  unit: PassUnit;
  value: T;
}

export interface PassAbilityItem {
  group: StoryGuideChronicleAbilityGroup;
  name: string;
  detail: string | null;
  since: number;
}

/** A copied item label ("Concept: enchanted): ...") opens some lines from a novel's status screens. */
const COPIED_LABEL = /^(?:(?:concept|idea|item|object|skill|spell|trait|status|ability)\s*:\s*)?(?:[\p{L}-]+\)\s*:\s*)?/iu;

/** The line without a copied label, capitalised, or null when it is shouted system text rather than prose. */
export function aboutText(text: string): string | null {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length && letters.filter((letter) => /\p{Lu}/u.test(letter)).length > letters.length / 2) return null;
  const rest = text.replace(COPIED_LABEL, '').trim();
  return rest ? rest[0].toUpperCase() + rest.slice(1) : null;
}

/** What the one pass has said so far, by cast-list id (an entity, or a member before its join). */
export class PassState {
  readonly slots = new Map<string, PassSlot>();
  readonly timeline = new Map<string, Stamped<{ note: string | null; at: number | null }>[]>();
  readonly facts = new Map<string, Stamped<PassFact>[]>();
  readonly about = new Map<string, Stamped<string>[]>();
  /** The last sentence each entry's `about` was asked about, kept or not, so a refused rewrite is not asked again every unit. */
  readonly aboutAsked = new Map<string, number>();
  readonly now = new Map<string, Stamped<string>[]>();
  readonly abilities = new Map<string, Stamped<PassAbilityItem[]>[]>();
  readonly pairs = new Map<string, { a: PassSlot; b: PassSlot; versions: Stamped<string>[] }>();
  readonly ties: Stamped<PassTie>[] = [];
  readonly summaries: Stamped<string>[] = [];
  readonly merges: Stamped<{ a: PassSlot; b: PassSlot; cite: number }>[] = [];

  /** Records a unit's checked answer; returns the ids that gained an identity fact (status facts feed `now` instead). */
  apply(unit: PassUnit, slots: readonly PassSlot[], answer: PassAnswer): string[] {
    for (const slot of slots) this.slots.set(slot.id, slot);
    const notes = new Map(answer.notes.map((note) => [note.slot.id, note]));
    for (const slot of slots) {
      const note = notes.get(slot.id);
      push(this.timeline, slot.id, { unit, value: { note: note?.note ?? null, at: note?.at ?? null } });
    }
    for (const fact of answer.facts) push(this.facts, fact.slot.id, { unit, value: fact });
    const changed = new Set<string>();
    for (const ability of answer.abilities) {
      const current = new Map((this.abilities.get(ability.slot.id)?.at(-1)?.value ?? []).map((item) => [item.name.toLowerCase(), item]));
      const key = ability.name.toLowerCase();
      if (ability.change === 'lost') current.delete(key);
      else
        current.set(key, {
          group: ability.group,
          name: ability.name,
          detail: ability.detail,
          since: current.get(key)?.since ?? ability.cite,
        });
      const list = [...current.values()];
      const versions = this.abilities.get(ability.slot.id) ?? [];
      // A gain the list already holds (a prompt shows only the abilities its text names) changes nothing.
      if (JSON.stringify(list) === JSON.stringify(versions.at(-1)?.value ?? [])) continue;
      if (versions.at(-1)?.unit === unit) versions[versions.length - 1] = { unit, value: list };
      else versions.push({ unit, value: list });
      this.abilities.set(ability.slot.id, versions);
      changed.add(ability.slot.id);
    }
    for (const tie of answer.ties) this.addTie(unit, tie);
    for (const merge of answer.merges) this.merges.push({ unit, value: merge });
    if (answer.summary) this.summaries.push({ unit, value: answer.summary });
    return [...new Set(answer.facts.filter((fact) => !fact.status).map((fact) => fact.slot.id))];
  }

  addTie(unit: PassUnit, tie: PassTie): void {
    this.ties.push({ unit, value: tie });
    const key = [tie.a.id, tie.b.id].sort().join('|');
    const pair = this.pairs.get(key) ?? { a: tie.a, b: tie.b, versions: [] };
    const last = pair.versions.at(-1);
    if (last?.unit === unit) pair.versions[pair.versions.length - 1] = { unit, value: tie.sentence };
    else if (last?.value !== tie.sentence) pair.versions.push({ unit, value: tie.sentence });
    this.pairs.set(key, pair);
  }

  /** The id's identity facts so far, oldest first. */
  factsOf(id: string): Stamped<PassFact>[] {
    return (this.facts.get(id) ?? []).filter((fact) => !fact.value.status);
  }

  /** The id's status facts so far, oldest first. */
  statusOf(id: string): Stamped<PassFact>[] {
    return (this.facts.get(id) ?? []).filter((fact) => fact.value.status);
  }

  currentNow(id: string): string | null {
    return this.now.get(id)?.at(-1)?.value ?? null;
  }

  /** A new `now` version, kept only when its text changes. */
  setNow(id: string, unit: PassUnit, text: string): void {
    if (this.currentNow(id) === text) return;
    push(this.now, id, { unit, value: text });
  }

  currentAbout(id: string): string | null {
    return this.about.get(id)?.at(-1)?.value ?? null;
  }

  /** The `about` as it stood once the unit ending at sentence `through` was done. */
  aboutAt(id: string, through: number): string | null {
    return stampedBy(this.about.get(id) ?? [], through)?.value ?? null;
  }

  /** The newest chunk summary written by the end of sentence `through`. */
  summaryAt(through: number): string | null {
    return stampedBy(this.summaries, through)?.value ?? null;
  }

  /** A new `about` version, kept only when its text changes; a status-screen line pasted in whole is no description. */
  setAbout(id: string, unit: PassUnit, text: string): void {
    const value = aboutText(text);
    if (!value || this.currentAbout(id) === value) return;
    push(this.about, id, { unit, value });
  }

  /**
   * The abilities list as the prompt shows it, as it stood by the end of sentence `through`. With `within`, the text a prompt
   * reads, only the abilities it names are listed and the rest counted, so a long list does not ride along in every prompt.
   */
  abilitiesText(id: string, through = Infinity, within?: string): string | null {
    const items = stampedBy(this.abilities.get(id) ?? [], through)?.value;
    if (!items?.length) return null;
    const text = within?.toLowerCase();
    const shown = text === undefined ? items : items.filter((item) => text.includes(item.name.toLowerCase()));
    const rest = items.length - shown.length;
    return [
      ...shown.map((item) => `${item.name} (${item.group}${item.detail ? `, ${item.detail}` : ''})`),
      ...(rest ? [`${rest} more not named here`] : []),
    ].join('; ');
  }
}

function stampedBy<T>(versions: readonly Stamped<T>[], through: number): Stamped<T> | undefined {
  return versions.findLast((version) => (version.unit.ordinals.at(-1) ?? 0) <= through);
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** An `about` built by code from the facts so far: the newest that fit in `ABOUT_WORDS` words, in reading order, repeats left out. */
export function factsAbout(facts: readonly Stamped<PassFact>[]): string {
  const seen = new Set<string>();
  const kept: string[] = [];
  let count = 0;
  for (const { value } of [...facts].reverse()) {
    const text = value.text.replace(/\s+/g, ' ').trim();
    const folded = text.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '');
    if (seen.has(folded)) continue;
    const words = text.split(' ').length;
    if (count + words > ABOUT_WORDS) break;
    seen.add(folded);
    kept.push(/[.!?]$/.test(text) ? text : `${text}.`);
    count += words;
  }
  return kept.reverse().join(' ');
}

/** Texts that name someone a reader at their unit's end has not met: the code spoiler check, which should find none. */
export function spoilerSweep(state: PassState, namesAt: (unit: PassUnit) => LineNames): { field: string; id: string; names: string[] }[] {
  const found: { field: string; id: string; names: string[] }[] = [];
  const check = (field: string, id: string, unit: PassUnit, text: string | null) => {
    if (!text) return;
    const names = namedLater(text, namesAt(unit));
    if (names.length) found.push({ field, id, names });
  };
  for (const [id, entries] of state.timeline) for (const entry of entries) check('note', id, entry.unit, entry.value.note);
  for (const [id, versions] of state.about) for (const version of versions) check('about', id, version.unit, version.value);
  for (const [id, versions] of state.now) for (const version of versions) check('now', id, version.unit, version.value);
  for (const [id, facts] of state.facts) for (const fact of facts) check('fact', id, fact.unit, fact.value.text);
  for (const [key, pair] of state.pairs) for (const version of pair.versions) check('pair', key, version.unit, version.value);
  for (const summary of state.summaries) check('summary', summary.unit.id, summary.unit, summary.value);
  return found;
}

/** Counts for one repeat, for the run record. */
export function stateCounts(state: PassState): Record<string, number> {
  const entries = [...state.timeline.values()].flat();
  return {
    timelineEntries: entries.length,
    notes: entries.filter((entry) => entry.value.note).length,
    facts: [...state.facts.values()].flat().length,
    aboutVersions: [...state.about.values()].flat().length,
    nowVersions: [...state.now.values()].flat().length,
    abilitySnapshots: [...state.abilities.values()].flat().length,
    ties: state.ties.length,
    pairs: state.pairs.size,
    merges: state.merges.length,
    summaries: state.summaries.length,
  };
}

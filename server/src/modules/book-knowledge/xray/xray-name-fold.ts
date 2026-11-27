import type { StoryGuideEntityKind } from '@bookorbit/types';
import type { XrayEntity } from './xray-entities';

/** One spelling of a name for comparison: case, spaces, hyphens and dots folded, so "Rell-gate" and "rell gate" match. */
export function foldName(name: string): string {
  return name.toLowerCase().replace(/[\s\p{Pd}_.'’]+/gu, '');
}

const JOINED = /\s(?:and|&)\s/iu;
const SPLIT = /\s*,\s*(?:(?:and|&)\s+)?|\s+(?:and|&)\s+/iu;

/** The names a list joins ("Quill and Bram", "Quill, Bram & Sef"), or none when the name is not a joined list. */
export function joinedParts(name: string): string[] {
  if (!JOINED.test(name)) return [];
  const parts = name
    .split(SPLIT)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length >= 2 ? parts : [];
}

/** Whether `part` is one of the names `whole` joins. */
export function isJoinedPart(whole: string, part: string): boolean {
  const folded = foldName(part);
  return joinedParts(whole).some((name) => foldName(name) === folded);
}

const PART_KINDS: ReadonlySet<StoryGuideEntityKind> = new Set(['character', 'group']);

/**
 * Entries whose name only joins other entries' names, each a character or group ("Quill and Bram" beside Quill and
 * Bram): two people fused into one entry. A name whose parts are not entries of their own ("Salt and Ember", a tavern) stays.
 */
type NamedEntry = { key: string; names: readonly string[]; kind: StoryGuideEntityKind };

/** `owners` may hold names that are no entries of their own, such as a minor character named too rarely to be listed. */
export function fusedEntries(entries: readonly NamedEntry[], owners: readonly NamedEntry[] = entries): Set<string> {
  const ownersOf = new Map<string, Set<string>>();
  for (const entry of owners) {
    if (!PART_KINDS.has(entry.kind)) continue;
    for (const name of entry.names) {
      const folded = foldName(name);
      if (!ownersOf.has(folded)) ownersOf.set(folded, new Set());
      ownersOf.get(folded)!.add(entry.key);
    }
  }
  const fused = new Set<string>();
  for (const entry of entries) {
    const parts = joinedParts(entry.names[0] ?? '');
    if (parts.length && parts.every((part) => [...(ownersOf.get(foldName(part)) ?? [])].some((key) => key !== entry.key))) fused.add(entry.key);
  }
  return fused;
}

/**
 * Entries whose names differ only by case, spacing or hyphens ("Rell-gate", "Rell gate") are one: the more mentioned
 * spelling keeps the entry and its kind, the other becomes one of its names.
 */
export function foldSpellings(entities: readonly XrayEntity[]): XrayEntity[] {
  const heads = new Map<string, XrayEntity>();
  const byCount = [...entities].sort((a, b) => b.count - a.count || a.first - b.first);
  for (const entity of byCount) {
    const folded = foldName(entity.name);
    const head = heads.get(folded);
    if (!head) {
      heads.set(folded, entity);
      continue;
    }
    head.ordinals = [...new Set([...head.ordinals, ...entity.ordinals])].sort((a, b) => a - b);
    head.count += entity.count;
    head.first = Math.min(head.first, entity.first);
    head.rank = Math.min(head.rank, entity.rank);
    for (const ordinal of entity.defining) head.defining.add(ordinal);
    for (const name of entity.names) if (!head.names.some(({ text }) => text === name.text)) head.names.push(name);
    head.joins.push(...entity.joins);
  }
  const kept = new Set(heads.values());
  return entities.filter((entity) => kept.has(entity));
}

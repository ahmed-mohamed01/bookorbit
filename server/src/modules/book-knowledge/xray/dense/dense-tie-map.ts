import type { BookKnowledgeXrayMode } from '@bookorbit/types';
import { tieTypes, type XrayTieType } from '../xray-tie-types';

/** A near-miss tie type and the allowed one it means; `reversed` when its sides swap ("child_of" is "parent_of" read backwards). */
type Near = [given: string, type: string, reversed?: true];

const FICTION_NEAR: readonly Near[] = [
  ['ally_of', 'friend_of'],
  ['allied_with', 'friend_of'],
  ['allies_with', 'friend_of'],
  ['companion_of', 'friend_of'],
  ['married_to', 'spouse_of'],
  ['husband_of', 'spouse_of'],
  ['wife_of', 'spouse_of'],
  ['brother_of', 'sibling_of'],
  ['sister_of', 'sibling_of'],
  ['father_of', 'parent_of'],
  ['mother_of', 'parent_of'],
  ['child_of', 'parent_of', true],
  ['son_of', 'parent_of', true],
  ['daughter_of', 'parent_of', true],
  ['grandfather_of', 'grandparent_of'],
  ['grandmother_of', 'grandparent_of'],
  ['grandchild_of', 'grandparent_of', true],
  ['uncle_of', 'aunt_or_uncle_of'],
  ['aunt_of', 'aunt_or_uncle_of'],
  ['related_to', 'relative_of'],
  ['engaged_to', 'betrothed_to'],
  ['fiance_of', 'betrothed_to'],
  ['in_love_with', 'loves'],
  ['lover_of', 'loves'],
  ['teacher_of', 'teaches'],
  ['mentor_of', 'teaches'],
  ['trains', 'teaches'],
  ['student_of', 'teaches', true],
  ['apprentice_of', 'teaches', true],
  ['pupil_of', 'teaches', true],
  ['attends', 'studies_at'],
  ['student_at', 'studies_at'],
  ['employed_by', 'works_for'],
  ['serves', 'works_for'],
  ['servant_of', 'works_for'],
  ['employs', 'works_for', true],
  ['belongs_to', 'member_of'],
  ['part_of', 'member_of'],
  ['lives_in', 'lives_at'],
  ['resides_at', 'lives_at'],
  ['resides_in', 'lives_at'],
  ['owner_of', 'owns'],
  ['owned_by', 'owns', true],
  ['pet_of', 'owns', true],
  ['bonded_with', 'bonded_to'],
  ['bound_to', 'bonded_to'],
];

const NONFICTION_NEAR: readonly Near[] = [
  ['component_of', 'part_of'],
  ['instance_of', 'example_of'],
  ['type_of', 'kind_of'],
  ['subtype_of', 'kind_of'],
  ['is_a', 'kind_of'],
  ['coined_by', 'proposed_by'],
  ['introduced_by', 'proposed_by'],
  ['advocated_by', 'proposed_by'],
  ['developed_by', 'proposed_by'],
  ['proposes', 'proposed_by', true],
  ['coined', 'proposed_by', true],
  ['causes', 'leads_to'],
  ['results_in', 'leads_to'],
  ['caused_by', 'leads_to', true],
  ['results_from', 'leads_to', true],
  ['opposed_to', 'contrasts_with'],
  ['versus', 'contrasts_with'],
  ['method_of', 'method_for'],
  ['technique_for', 'method_for'],
  ['approach_to', 'method_for'],
];

const NEAR = {
  fiction: new Map(FICTION_NEAR.map(([given, ...rest]) => [given, rest])),
  nonfiction: new Map(NONFICTION_NEAR.map(([given, ...rest]) => [given, rest])),
};

/** Case, spaces and hyphens to the registry's spelling: "Friend Of" and "friend-of" read as "friend_of". */
function spelled(type: string): string {
  return type
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/^(?:is|are|was)_/, '');
}

/** "friends_of", "allies" and "enemies": each word in the singular. */
function singular(type: string): string {
  return type
    .split('_')
    .map((word) => (word.endsWith('ies') ? `${word.slice(0, -3)}y` : word.length > 3 && /[^s]s$/.test(word) ? word.slice(0, -1) : word))
    .join('_');
}

export interface MappedTieType {
  info: XrayTieType;
  reversed: boolean;
  /** Set when the given type was not the allowed spelling: "given->type". */
  mapped: string | null;
}

/**
 * The allowed tie type a model's type means: the type itself, or a near miss in case, spacing,
 * number, a missing "_of", or a synonym in the mode's table. Undefined when nothing maps.
 */
export function mapTieType(given: unknown, mode: BookKnowledgeXrayMode): MappedTieType | undefined {
  if (typeof given !== 'string' || !given.trim()) return undefined;
  const lookup = tieTypes(mode);
  const exact = lookup(given);
  if (exact) return { info: exact, reversed: false, mapped: null };
  const near = NEAR[mode];
  const base = spelled(given);
  for (const candidate of new Set([base, singular(base), `${base}_of`, `${singular(base)}_of`])) {
    const direct = lookup(candidate);
    const [type, reversed] = direct ? [candidate, undefined] : (near.get(candidate) ?? []);
    const info = direct ?? (type ? lookup(type) : undefined);
    if (info) return { info, reversed: reversed === true, mapped: `${given}->${info.type}${reversed ? ' (reversed)' : ''}` };
  }
  return undefined;
}

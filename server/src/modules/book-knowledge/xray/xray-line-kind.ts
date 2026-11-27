import type { BookKnowledgeXraySub, StoryGuideEntityKind } from '@bookorbit/types';

/**
 * Every description prompt asks the line to say first what the entry is ("A border town", "A people at war"), so its
 * head noun is a second opinion on the kind. Only these plain heads count; anything else leaves the kind alone.
 */
const HEADS: readonly [StoryGuideEntityKind, string][] = [
  ['group', 'people|peoples|species|tribe|clan|race|nation|order|guild|army|corps|band|faction|family|house|company|cult|sect|council'],
  ['idea', 'language|tongue|dialect|script|path|class|skill|spell|ability|technique|stat|attribute|school of magic|discipline'],
  [
    'place',
    'place|location|country|town|city|village|fort|fortress|region|land|continent|kingdom|realm|forest|mountain|river|tavern|inn|valley|island|province',
  ],
  ['character', 'man|woman|girl|boy|person|soldier|knight|merchant|priest|priestess|child|warrior|mage|witch'],
];
const LEAD = String.raw`^(?:a|an|the)\s+(?:[\p{L}'-]+\s+){0,3}?`;
const HEAD_RES = HEADS.map(([kind, nouns]) => [kind, new RegExp(`${LEAD}(?:${nouns})(?![\\p{L}'-])`, 'iu')] as const);

/** The kind a description's opening noun names, when it is one of the plain heads above. */
export function kindFromLine(line: string): StoryGuideEntityKind | null {
  let best: { kind: StoryGuideEntityKind; at: number } | null = null;
  for (const [kind, re] of HEAD_RES) {
    const match = re.exec(line);
    if (match && (!best || match[0].length < best.at)) best = { kind, at: match[0].length };
  }
  return best?.kind ?? null;
}

/** Kinds a line may correct: a person, place or group the kinds step misfiled; objects and ideas named by a person stay. */
const CORRECTABLE: Partial<Record<StoryGuideEntityKind, readonly StoryGuideEntityKind[]>> = {
  character: ['group', 'idea', 'place'],
  place: ['group', 'idea'],
  group: ['idea', 'place'],
};

export function correctedKind(kind: StoryGuideEntityKind, line: string | null | undefined): StoryGuideEntityKind {
  if (!line) return kind;
  const said = kindFromLine(line);
  return said && CORRECTABLE[kind]?.includes(said) ? said : kind;
}

/**
 * A line that only says another character is this ("Tavia is a skyling.") marks a word for that character, not an
 * entry of its own. Returns the character's name.
 */
export function descriptorOf(line: string | null | undefined, own: readonly string[]): string | null {
  if (!line) return null;
  const match = /^(\p{Lu}[\p{L}'-]*(?:\s+\p{Lu}[\p{L}'-]*)?)\s+is\s+(?:a|an|the)\s+(?:(?:young|baby|little|small)\s+)?([\p{L}' -]+?)\.?$/u.exec(
    line.trim(),
  );
  if (!match) return null;
  const word = match[2].toLowerCase();
  return own.some((name) => {
    const lower = name.toLowerCase();
    return word === lower || word === `${lower}s` || `${word}s` === lower;
  })
    ? match[1]
    : null;
}

const SUB_WORDS: Partial<Record<BookKnowledgeXraySub, RegExp>> = {
  spirit: /\b(?:spirits?|ghosts?|wraiths?|souls?|phantoms?|specters?|spectres?|supernatural|demons?|elementals?|fae|fey|undead)\b/i,
  god: /\b(?:gods?|goddess(?:es)?|deity|deities|divine|divinity)\b/i,
};

/** A god or spirit subtype comes from tagger votes; it stands only on a character whose description says so. */
export function checkedSub(
  sub: BookKnowledgeXraySub | null,
  kind: StoryGuideEntityKind,
  line: string | null | undefined,
): BookKnowledgeXraySub | null {
  if (!sub) return null;
  const words = SUB_WORDS[sub];
  if (!words) return sub;
  return kind === 'character' && line && words.test(line) ? sub : null;
}

import { type LineName, type LineNames } from '../../story-guides/pipeline/lines-step';
import {
  escapeRegExp,
  FAMILY_AND_ROLE_WORDS,
  HONORIFIC_ONLY,
  isNumberOnly,
  NAME_PREFIX_WORDS,
  nameKey,
  TITLES,
  WORD_CHAR,
} from '../../story-guides/pipeline/name-text';
import { type XrayEntity, type XrayName } from './xray-entities';

function lineName(name: string): LineName {
  return { text: name, pattern: new RegExp(`(?<!${WORD_CHAR})${escapeRegExp(name.replace(/’/g, "'"))}(?!${WORD_CHAR})`, 'gu') };
}

/** The names a reader at `checkpoint` has seen, and the later ones a text written there must not use. */
export function namesAt(entities: readonly XrayEntity[], checkpoint: number): LineNames {
  const generic = new Set([...TITLES, ...NAME_PREFIX_WORDS, ...HONORIFIC_ONLY, ...FAMILY_AND_ROLE_WORDS]);
  const first = new Map<string, XrayName>();
  for (const entity of entities)
    for (const name of [...entity.names, ...entity.joins.flatMap((join) => join.names)]) {
      const key = nameKey(name.text);
      const known = first.get(key);
      if (!known || name.ordinal < known.ordinal) first.set(key, name);
    }
  const names: LineNames = { later: [], visible: [] };
  for (const [key, name] of first) {
    if (name.ordinal <= checkpoint) names.visible.push(lineName(name.text));
    else if (!isNumberOnly(name.text) && !key.split(' ').every((word) => generic.has(word))) names.later.push(lineName(name.text));
  }
  return names;
}

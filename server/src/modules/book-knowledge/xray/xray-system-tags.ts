import type { BookKnowledgeXrayEntity } from '@bookorbit/types';
import type { Sentence } from '../core/model';
import { SYSTEM_SKILL_NOTICE, systemLine } from './dense/dense-links';

type Evidence = 'stat' | 'skill' | 'level';
type Tag = BookKnowledgeXrayEntity['tag'];

const RANK = /^(.+?)(?:\s*:\s*|\s+)(?:reached\s+)?(?:novice|beginner|apprentice|adept|journeyman|expert|master|grandmaster)(?:\s+\d+)?$/i;
const LEVEL = /^(.+?)(?:\s*:\s*|\s+)(reached\s+)?(?:level|lv\.?)\s+\d+$/i;
const STAT = /^(.+?)(?:\s*:\s*|\s+(?:increased\s+to\s+)?)[+-]?\d+(?:\s*\([+-]\d+\))?$/i;

const nameKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

function evidenceOf(text: string): [string, Evidence] | undefined {
  const row = text
    .trim()
    .replace(/^\[\s*/, '')
    .replace(/[\s.!\]]+$/, '');
  const skill = SYSTEM_SKILL_NOTICE.exec(row) ?? RANK.exec(row);
  if (skill) return [skill[1], 'skill'];
  const level = LEVEL.exec(row);
  if (level) return [level[1], level[2] ? 'skill' : 'level'];
  const stat = STAT.exec(row);
  if (stat) return [stat[1], 'stat'];
}

export function indexSystemLines(sentences: readonly Sentence[], through: number): (names: readonly string[], at?: number) => Tag {
  const byName = new Map<string, Record<Evidence, number[]>>();
  for (const sentence of sentences) {
    if (sentence.ordinal > through) break;
    if (sentence.structure !== 'body' || sentence.heading || sentence.caption || !systemLine(sentence.text)) continue;
    const evidence = evidenceOf(sentence.text);
    if (!evidence) continue;
    const [name, kind] = evidence;
    const key = nameKey(name);
    const ordinals = byName.get(key) ?? { stat: [], skill: [], level: [] };
    // Tag decisions only need the first two matches of each kind.
    if (ordinals[kind].length < 2) ordinals[kind].push(sentence.ordinal);
    byName.set(key, ordinals);
  }
  return (names, at = through) => {
    let stats = 0;
    let skills = 0;
    let levels = 0;
    for (const key of new Set(names.map(nameKey))) {
      const ordinals = byName.get(key);
      if (!ordinals) continue;
      stats += ordinals.stat.filter((ordinal) => ordinal <= at).length;
      skills += ordinals.skill.filter((ordinal) => ordinal <= at).length;
      levels += ordinals.level.filter((ordinal) => ordinal <= at).length;
    }
    if (stats >= 2) return 'stat';
    if (skills >= 1 || levels >= 2) return 'skill';
  };
}

export function systemTag(names: readonly string[], sentences: readonly Sentence[], through: number): Tag {
  return indexSystemLines(sentences, through)(names);
}

import { deltaEncode } from '../core/artifact';
import { bodyText, KIND_LABELS } from '../core/kind-cues';
import type { ModelVote, Sentence } from '../core/model';
import { termKey } from '../core/text-utils';
import { PYTHON_NON_SPACE } from './protocol';

const bodyWords = new RegExp(`${PYTHON_NON_SPACE.source}+`, 'gu');

export function countBodyWords(sentences: readonly Sentence[]): number {
  return sentences.reduce((total, sentence) => total + (sentence.structure === 'body' ? (sentence.text.match(bodyWords)?.length ?? 0) : 0), 0);
}

// The ranking vote keeps the retired 5-label pass's scope: person or character and concept or idea, and the
// kind labels that fall under them. Places, groups, objects, events, titles and animals never voted for ranking.
const VOTING_LABELS = new Set<number>(
  (
    ['person or character', 'god or deity', 'spirit or supernatural being', 'concept or idea', 'magic or power system', 'force or energy'] as const
  ).map((label) => KIND_LABELS.indexOf(label)),
);

// A voting span counts as a detection of its text, from the window end on.
export function votesFromKindSpans(sentences: readonly Sentence[], spans: readonly number[]): ModelVote[] {
  const text = bodyText(sentences).text;
  const detections = new Map<string, number[]>();
  for (let index = 0; index < spans.length; index += 4) {
    if (!VOTING_LABELS.has(spans[index + 2])) continue;
    const key = termKey(text.slice(spans[index], spans[index + 1]));
    if (!key) continue;
    const ordinals = detections.get(key);
    if (ordinals) ordinals.push(spans[index + 3]);
    else detections.set(key, [spans[index + 3]]);
  }
  return Array.from(detections, ([key, ordinals]) => ({ key, deltas: deltaEncode(ordinals) }));
}

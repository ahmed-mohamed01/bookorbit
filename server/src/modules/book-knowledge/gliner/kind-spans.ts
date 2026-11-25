import { bodyText, KIND_LABELS, type BodyText } from '../core/kind-cues';
import type { Sentence } from '../core/model';
import { GLINER_THRESHOLD, PYTHON_NON_SPACE, type GlinerRunner } from './protocol';

export const KIND_SPANS_VERSION = 2;
const WINDOW_WORDS = 200;
const word = new RegExp(`${PYTHON_NON_SPACE.source}+`, 'gu');

function ordinalAt(body: BodyText, offset: number): number {
  let low = 0;
  let high = body.offsets.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (body.offsets[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return body.ordinals[low];
}

// Non-overlapping 200-word windows across paragraphs. A span becomes usable once the reader has finished the
// window's last sentence, because the model saw the whole window.
export async function collectKindSpans(sentences: readonly Sentence[], runner: GlinerRunner): Promise<{ spans: number[]; windows: number }> {
  const body = bodyText(sentences);
  const spans: number[] = [];
  let windows = 0;
  let first: number | undefined;
  let last = 0;
  let count = 0;
  const flush = async () => {
    if (first === undefined) return;
    const predicted = await runner.predict(body.text.slice(first, last), KIND_LABELS, GLINER_THRESHOLD);
    const available = ordinalAt(body, last - 1);
    for (const span of predicted) {
      const label = KIND_LABELS.indexOf(span.label as (typeof KIND_LABELS)[number]);
      if (label >= 0) spans.push(first + span.start, first + span.end, label, available);
    }
    windows++;
    first = undefined;
    count = 0;
  };
  for (const match of body.text.matchAll(word)) {
    first ??= match.index;
    last = match.index + match[0].length;
    if (++count === WINDOW_WORDS) await flush();
  }
  await flush();
  return { spans, windows };
}

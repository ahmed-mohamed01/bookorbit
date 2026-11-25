import { describe, expect, it, vi } from 'vitest';
import { KIND_LABELS } from '../core/kind-cues';
import type { Sentence } from '../core/model';
import { GLINER_THRESHOLD } from './protocol';
import { collectKindSpans } from './kind-spans';

function sentence(ordinal: number, text: string, structure: Sentence['structure'] = 'body'): Sentence {
  return { ordinal, text, spineIndex: 0, paragraphIndex: ordinal, href: 'invented.xhtml', structure, heading: false, emphasis: [] };
}

describe('kind spans', () => {
  it('runs 200-word windows across paragraphs and makes each span usable at the window end', async () => {
    const runner = {
      predict: vi.fn((text: string) =>
        Promise.resolve(
          Array.from(text.matchAll(/Veyra/g), (match) => ({
            start: match.index,
            end: match.index + 5,
            text: 'Veyra',
            label: 'person or character',
            score: 0.9,
          })),
        ),
      ),
      release: vi.fn(async () => {}),
    };
    const sentences = [
      sentence(1, `Veyra ${'word '.repeat(148)}end.`),
      sentence(2, 'Skipped Veyra notes.', 'notes'),
      sentence(3, `${'word '.repeat(49)}Veyra ${'word '.repeat(10)}`),
      sentence(4, 'Veyra waits.'),
    ];
    const { spans, windows } = await collectKindSpans(sentences, runner);
    expect(windows).toBe(2);
    expect(runner.predict).toHaveBeenCalledWith(expect.any(String), KIND_LABELS, GLINER_THRESHOLD);
    expect(runner.predict.mock.calls.map(([text]) => text.split(/\s+/).length)).toEqual([200, 12]);
    const first = sentences[0].text.length + 1;
    expect(spans).toEqual([
      0,
      5,
      0,
      3,
      first + 245,
      first + 250,
      0,
      3,
      first + sentences[2].text.length + 1,
      first + sentences[2].text.length + 6,
      0,
      4,
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import { bookIndex } from './book-index';
import type { Artifact } from './model';

const index = (lines: string[]) => bookIndex({ seeds: [lines.join('\n')] } as unknown as Artifact);

describe('book index headings', () => {
  it('strips page lists that no comma introduces', () => {
    const fillers = Array.from({ length: 19 }, (_, i) => `entry ${String.fromCharCode(98 + i)} ${i + 10}, ${i + 30}`);
    const headings = index([
      'INDEX',
      'A',
      ...fillers,
      'boxing 129–131, 143, 156–157',
      'brain–computer interfaces 44–48, 51; see also cyborg',
      'C. elegans34–35, 266, 267',
      'moral rightness (MR)217–220.296, 297',
      'value learning 123n4, 130',
      'Area 51 12',
      'AI-OUM, see optimality notions',
      'future of 19, 292',
      'learning & exploration hypothesis 230',
    ]);
    for (const key of [
      'entry b',
      'boxing',
      'brain-computer interface',
      'cyborg',
      'c elegan',
      'moral rightness',
      'value learning',
      'area 51',
      'ai-oum',
      'optimality notion',
    ])
      expect(headings).toContain(key);
    for (const key of ['boxing 129', 'entry b 10', 'future of', 'future', 'learning exploration hypothesis', 'index', 'a'])
      expect(headings).not.toContain(key);
  });

  it('keeps numbers in names when commas introduce the page lists', () => {
    const fillers = Array.from({ length: 19 }, (_, i) => `Entry ${String.fromCharCode(97 + i)}, ${i + 10}`);
    const headings = index([...fillers, 'Apollo 11, 45–47', 'Ethics of, 11–12', 'Digital minds, 10. See also Uploading']);
    expect(headings).toContain('apollo 11');
    expect(headings).toContain('digital mind');
    expect(headings).not.toContain('ethics of');
  });
});

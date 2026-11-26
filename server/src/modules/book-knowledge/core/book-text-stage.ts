import { readBookText } from '../../story-guides/text/book-text-reader';
import { storySections } from '../../story-guides/text/story-sections';
import { extractEpubText } from './epub-text.js';
import type { TextStage } from './model';
import { createWinkNlp } from './wink';

/**
 * Every linear sentence is kept so ordinals and spine bytes match the book, but only the text upstream's
 * story guide counts as story is `body`: matter and short pages before it are `front`, the rest `other`.
 */
export async function extractBookText(path: string, format: string): Promise<TextStage> {
  if (format === 'epub' || format === 'kepub') return extractEpubText(path);

  const book = await readBookText(path);
  const { sections } = book;
  const story = new Map(storySections(book).map((section) => [section.s, section]));
  let seenBody = false;
  const nlp = createWinkNlp(['sbd']);
  const spineBytes: number[] = Array(sections.length).fill(0);
  const result: TextStage = { sentences: [], seeds: [], spineBytes };
  let paragraphIndex = 0;
  for (const section of sections) {
    if (!section.linear) continue;
    spineBytes[section.index] = Buffer.byteLength(section.text);
    const range = story.get(section.index);
    let start = 0;
    for (const end of [...section.blocks.filter((offset) => offset > 0), section.text.length]) {
      const text = section.text.slice(start, end).replace(/\s+/g, ' ').trim();
      const body = range !== undefined && start < range.end && end > range.start;
      start = end;
      if (!text) continue;
      seenBody ||= body;
      const structure = body ? 'body' : seenBody ? 'other' : 'front';
      for (const sentence of nlp.readDoc(text).sentences().out() as string[]) {
        result.sentences.push({
          ordinal: result.sentences.length + 1,
          spineIndex: section.index,
          paragraphIndex,
          href: String(section.index),
          text: sentence,
          structure,
          heading: false,
          emphasis: [],
        });
      }
      paragraphIndex++;
    }
  }
  return result;
}

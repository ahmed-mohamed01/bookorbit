import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BookKnowledgeKindsService, servedKind } from './book-knowledge-kinds.service';
import { CLASSIFY_TEMPERATURE, type BookKnowledgeModelService } from './book-knowledge-model.service';
import type { BookKnowledgeRepository } from './book-knowledge.repository';
import { KIND_LABELS } from './core/kind-cues';
import { annotateKindCues } from './core/kind-cues';
import type { Artifact, Sentence } from './core/model';
import { extractTerms } from './core/term-extractor';
import { rankTerms } from './core/term-ranking';

function sentence(ordinal: number, text: string, spineIndex: number): Sentence {
  return { ordinal, text, spineIndex, paragraphIndex: ordinal, href: 'invented.xhtml', structure: 'body', heading: false, emphasis: [] };
}
const lines: [string, number][] = [
  ['Then Veyra and Ostrel met at the gate.', 0],
  ['Later Veyra and Ostrel left the gate.', 0],
  ['Then Veyra and Ostrel slept by the gate.', 0],
  ['Then Veyra and Ostrel rode to the gate.', 1],
  ['At dusk Veyra and Ostrel were crowned.', 1],
];
const sentences = lines.map(([text, spine], index) => sentence(index + 1, text, spine));
const spans: number[] = [];
let offset = 0;
for (const value of sentences) {
  const start = value.text.indexOf('Veyra');
  spans.push(offset + start, offset + start + 5, KIND_LABELS.indexOf('person or character'), value.ordinal);
  offset += value.text.length + 1;
}
const terms = extractTerms(sentences);
annotateKindCues(sentences, terms, spans);
const artifact: Artifact = {
  formatVersion: 3,
  textVersion: 1,
  termsVersion: 1,
  fingerprint: '',
  seeds: [],
  aliasLinks: [],
  sentences,
  terms,
  metadata: { titles: ['The Hollow Lantern'], authors: ['Mira Quell'] },
};
const ranked = rankTerms(artifact, 5);

function setup(configured = true) {
  const rows: { requestHash: string; answers: Record<string, string> }[] = [];
  const repo = {
    kindReviews: vi.fn((_bookId: number, _fingerprint: string, hashes: string[]) =>
      Promise.resolve(rows.filter((row) => hashes.includes(row.requestHash))),
    ),
    saveKindReview: vi.fn((value: { requestHash: string; answers: Record<string, string> }) => {
      rows.push(value);
      return Promise.resolve();
    }),
  };
  const model = {
    chat: vi.fn(() => Promise.resolve('{"e1": "place"}')),
    choice: vi.fn(() => Promise.resolve(configured ? { slot: 'fast', model: 'local-model' } : null)),
  };
  const service = new BookKnowledgeKindsService(model as unknown as BookKnowledgeModelService, repo as unknown as BookKnowledgeRepository);
  return { service, model, repo };
}

describe('BookKnowledgeKindsService', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('maps kinds onto the served type and keeps the old type for no kind', () => {
    expect(servedKind('concept', undefined, 'animal')).toEqual({ type: 'person', kind: 'animal', kindSubtype: null, junk: false });
    expect(servedKind('person', undefined, 'group')).toMatchObject({ type: 'concept', kind: 'group' });
    expect(servedKind('place', undefined, 'junk')).toEqual({ type: 'place', kind: null, kindSubtype: null, junk: true });
    expect(servedKind('person')).toEqual({ type: 'person', kind: null, kindSubtype: null, junk: false });
  });

  it('leaves unsorted entries without a kind and calls nothing when no model is configured', async () => {
    const { service, model, repo } = setup(false);
    const kinds = await service.resolve(1, 'f', artifact, ranked, 5);
    expect(kinds.get('veyra')).toMatchObject({ kind: 'person', type: 'person' });
    expect(kinds.get('ostrel')).toMatchObject({ kind: null, type: 'concept', junk: false });
    expect(await service.review(1, 'f', artifact, 5)).toBe(0);
    expect(model.chat).not.toHaveBeenCalled();
    expect(repo.kindReviews).not.toHaveBeenCalled();
  });

  it('reviews unsorted entries once and reuses the cached answer at the same position', async () => {
    const { service, model, repo } = setup();
    expect(await service.review(1, 'f', artifact, 5)).toBe(1);
    expect(model.chat).toHaveBeenCalledTimes(1);
    const [system, user, maxOutputTokens] = model.chat.mock.calls[0] as unknown as [string, string, number];
    expect(system).toMatch(/^You sort index entries/);
    expect(user).toContain('"name": "Ostrel"');
    expect(user).toContain('"mentions": 3');
    expect(user).not.toMatch(/crowned|rode/);
    expect(user).not.toContain('"name": "Veyra"');
    expect(maxOutputTokens).toBe(4000);
    expect(repo.saveKindReview).toHaveBeenCalledWith(expect.objectContaining({ bookId: 1, fingerprint: 'f', answers: { ostrel: 'place' } }));
    expect(await service.review(1, 'f', artifact, 5)).toBe(0);
    const kinds = await service.resolve(1, 'f', artifact, ranked, 5);
    expect(kinds.get('ostrel')).toMatchObject({ kind: 'place', type: 'place' });
    expect(kinds.get('veyra')).toMatchObject({ kind: 'person' });
    expect(model.chat).toHaveBeenCalledTimes(1);
  });

  it('reviews kinds at the classification temperature', async () => {
    const { service, model } = setup();
    await service.review(1, 'f', artifact, 5);
    expect(model.chat).toHaveBeenCalledWith(expect.any(String), expect.any(String), 4000, expect.anything(), {
      temperature: CLASSIFY_TEMPERATURE,
    });
  });

  it('keeps rule kinds when the model fails', async () => {
    const { service, model, repo } = setup();
    model.chat.mockRejectedValue(new Error('offline'));
    await expect(service.review(1, 'f', artifact, 5)).rejects.toThrow('offline');
    expect(repo.saveKindReview).not.toHaveBeenCalled();
    const kinds = await service.resolve(1, 'f', artifact, ranked, 5);
    expect(kinds.get('ostrel')).toMatchObject({ kind: null });
    await vi.waitFor(() => expect(model.chat).toHaveBeenCalledTimes(2));
  });

  it('retries an unreadable answer once, then leaves the entry unsorted', async () => {
    const { service, model, repo } = setup();
    model.chat.mockResolvedValue('not json');
    expect(await service.review(1, 'f', artifact, 5)).toBe(2);
    expect(repo.saveKindReview).not.toHaveBeenCalled();
  });
});

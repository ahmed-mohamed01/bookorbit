import { describe, expect, it } from 'vitest';
import { oftenWith } from './artifact';
import type { Artifact, Sentence, VisibleTerm } from './model';
import { speakerExchanges } from './speaker-exchanges';
import { extractAliasLinks, extractTerms } from './term-extractor';
import { termKey } from './text-utils';

function sentence(ordinal: number, text: string, paragraphIndex = ordinal, spineIndex = 0): Sentence {
  return { ordinal, text, paragraphIndex, spineIndex, structure: 'body', href: 'invented.xhtml', heading: false, emphasis: [] };
}

function person(displayName: string, aliases: string[] = []): VisibleTerm {
  return {
    key: termKey(displayName),
    displayName,
    aliases,
    type: 'person',
    mentions: [],
    first: 1,
    latest: 1,
    count: 1,
    rarity: 1,
    wordCount: displayName.split(' ').length,
  };
}

function artifact(sentences: Sentence[]): Artifact {
  const terms = extractTerms(sentences);
  return {
    sentences,
    terms,
    aliasLinks: extractAliasLinks(sentences, terms),
    seeds: [],
    fingerprint: 'invented',
    formatVersion: 1,
    textVersion: 2,
    termsVersion: 2,
  };
}

describe('speaker exchanges', () => {
  it('attributes both trailing orders and paragraph-initial dialogue, including aliases and split sentences', () => {
    const sentences = [
      sentence(1, '“The door is open,”'),
      sentence(2, 'Élora Venn asked.', 1),
      sentence(3, '"Then go first," said Neravel.'),
      sentence(4, 'Brightwing replies: “I will.”'),
    ];
    const visible = [person('Élora Venn', ['Brightwing']), person('Neravel')];
    const exchanges = speakerExchanges(sentences, visible, 4);
    expect(exchanges.get('élora venn')?.get('neravel')).toEqual({ count: 2, first: 3 });
    expect(exchanges.get('neravel')?.get('élora venn')).toEqual({ count: 2, first: 2 });
    expect(speakerExchanges(sentences, visible, 3).get('neravel')?.get('élora venn')).toEqual({ count: 1, first: 2 });
  });

  it('accepts the specified past and present-tense attribution verbs', () => {
    const forms = [
      'said',
      'says',
      'asked',
      'asks',
      'replied',
      'replies',
      'whispered',
      'whispers',
      'called',
      'calls',
      'shouted',
      'shouts',
      'muttered',
      'mutters',
      'answered',
      'answers',
      'added',
      'adds',
      'snapped',
      'snaps',
      'noted',
      'notes',
      'told',
      'tells',
      'continued',
      'continues',
    ];
    const visible = [person('Elora'), person('Neravel')];
    for (const form of forms) {
      const sentences = [sentence(1, `“Wait,” Elora ${form}.`), sentence(2, '“Why?” Neravel asked.')];
      expect(speakerExchanges(sentences, visible, 2).get('elora')?.get('neravel'), form).toEqual({ count: 1, first: 2 });
    }
  });

  it('ignores non-body and unresolved turns, and breaks exchanges at the distance and spine boundaries', () => {
    const sentences = [
      sentence(1, '“Go,” Elora said.', 1),
      { ...sentence(2, '“Wait,” Neravel said.', 2), structure: 'notes' as const },
      sentence(3, '“Wait,” Copper said.', 3),
      sentence(4, '“Wait,” Neravel said.', 4),
      sentence(5, '“Again,” Neravel says.', 5),
      sentence(6, '“Stop,” Elora said.', 9),
      sentence(7, '“Stop,” Neravel said.', 10, 1),
      sentence(8, 'Elora said the door was open.', 11, 1),
      sentence(9, '“Wait,” Elora notedly frowned.', 12, 1),
    ];
    const visible = [person('Elora'), person('Neravel'), { ...person('Copper'), type: 'concept' as const }];
    const exchanges = speakerExchanges(sentences, visible, 9);
    expect([...exchanges.keys()]).toEqual(['elora', 'neravel']);
    expect(exchanges.get('elora')?.get('neravel')).toEqual({ count: 1, first: 4 });
  });

  it('keeps an ambiguous alias unresolved', () => {
    const sentences = [sentence(1, '“Go,” Brightwing said.'), sentence(2, '“Wait,” Neravel replied.')];
    const visible = [person('Elora', ['Brightwing']), person('Tavren', ['Brightwing']), person('Neravel')];
    expect(speakerExchanges(sentences, visible, 2).size).toBe(0);
  });
});

it('adds a dialogue-only partner after two exchanges and keeps full-artifact results equal to the rebuilt prefix', () => {
  const early = [
    sentence(1, '“Wait,” said Elora.'),
    sentence(2, '“I will,” Neravel replies.'),
    sentence(3, '“The door is open,”'),
    sentence(4, 'Elora added.', 3),
  ];
  const full = artifact([
    ...early,
    sentence(5, '“Then go first,” Neravel said.'),
    sentence(6, '“I can help,” Tavren said.'),
    sentence(7, '“Thank you,” Elora said.'),
    sentence(8, '“Follow me,” Tavren said.'),
  ]);
  expect(oftenWith(full, 'elora', 3)).toEqual([]);
  const related = [{ key: 'neravel', displayName: 'Neravel', count: 2, first: 2 }];
  expect(oftenWith(artifact(early), 'elora', 4)).toEqual(related);
  expect(oftenWith(full, 'elora', 4)).toEqual(related);
  expect(oftenWith(full, 'elora', 4, 2, 0)).toEqual([]);
  expect(oftenWith(full, 'elora', 8).map((term) => term.key)).toContain('tavren');
});

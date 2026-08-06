import { describe, expect, it } from 'vitest';

import { matchTranscript, type SpineText } from './reading-alignment-matcher.util';

describe('matchTranscript', () => {
  it('locates an exact transcript substring with high confidence in the right spine', () => {
    const spines: SpineText[] = [
      { spineIndex: 0, text: 'A short foreword about nothing much at all in particular.' },
      { spineIndex: 1, text: 'The old lighthouse stood at the edge of the world, its lamp sweeping the black water all night long.' },
      { spineIndex: 2, text: 'Chapter two begins somewhere else entirely with different words.' },
    ];
    const result = matchTranscript('its lamp sweeping the black water all night long', spines);

    expect(result).not.toBeNull();
    expect(result!.spineIndex).toBe(1);
    expect(result!.confidence).toBeGreaterThan(0.9);
    expect(spines[1]!.text).toContain(result!.phrase);
  });

  it('matches despite punctuation, case, and smart-quote differences', () => {
    const spines: SpineText[] = [
      { spineIndex: 0, text: 'She whispered, “Don’t look back now, Mr. O’Brien\u2014just keep walking toward the gate.”' },
    ];
    const result = matchTranscript('dont look back now mr obrien just keep walking toward the gate', spines);

    expect(result).not.toBeNull();
    expect(result!.spineIndex).toBe(0);
    expect(result!.confidence).toBeGreaterThan(0.8);
    expect(spines[0]!.text).toContain(result!.phrase);
  });

  it('tolerates a word variation (Mister vs Mr) and a dropped filler word', () => {
    const spines: SpineText[] = [{ spineIndex: 0, text: "She said that Mr. O'Brien would arrive before noon on Tuesday." }];
    // "Mister" for "Mr" and the filler "that" dropped.
    const result = matchTranscript('she said mister obrien would arrive before noon on tuesday', spines);

    expect(result).not.toBeNull();
    expect(result!.confidence).toBeGreaterThan(0.6);
    expect(spines[0]!.text).toContain(result!.phrase);
  });

  it('returns null when the transcript appears in no spine', () => {
    const spines: SpineText[] = [
      { spineIndex: 0, text: 'The garden was full of roses and the bees hummed lazily in the warm afternoon light.' },
      { spineIndex: 1, text: 'He counted the stairs as he climbed, one hundred and two in all, to the very top.' },
    ];
    const result = matchTranscript('quantum entanglement decoheres rapidly inside a noisy superconducting cavity', spines);

    expect(result).toBeNull();
  });

  it('extends a recurring phrase until it is unique within the spine', () => {
    const spine: SpineText = {
      spineIndex: 0,
      text: 'the bell rang and the door opened and the bell rang and the door opened and then silence fell over the room',
    };
    const result = matchTranscript('the bell rang and the door opened and then silence fell over the room', [spine]);

    expect(result).not.toBeNull();
    expect(result!.spineIndex).toBe(0);
    // The bare 8-word phrase recurs twice; the returned phrase must be extended
    // until it identifies exactly one location.
    const occurrences = spine.text.split(result!.phrase).length - 1;
    expect(occurrences).toBe(1);
    expect(spine.text).toContain(result!.phrase);
  });

  it('ignores a strong match outside the spineWindow', () => {
    const spines: SpineText[] = [
      { spineIndex: 0, text: 'Something unrelated about weather patterns over the northern sea in autumn.' },
      { spineIndex: 1, text: 'A dull passage listing inventory counts and shipping dates without any drama.' },
      { spineIndex: 5, text: 'The dragon uncoiled from the mountain and roared across the burning valley below.' },
    ];
    const phrase = 'the dragon uncoiled from the mountain and roared across the burning valley below';

    const withoutWindow = matchTranscript(phrase, spines);
    expect(withoutWindow).not.toBeNull();
    expect(withoutWindow!.spineIndex).toBe(5);

    const withWindow = matchTranscript(phrase, spines, { spineWindow: { min: 0, max: 2 } });
    expect(withWindow).toBeNull();
  });

  it('returns null for a too-short transcript', () => {
    const spines: SpineText[] = [{ spineIndex: 0, text: 'The lamp sweeping the black water all night long.' }];
    expect(matchTranscript('lamp sweeping black', spines)).toBeNull();
    expect(matchTranscript('', spines)).toBeNull();
  });

  it('always returns a phrase that is a verbatim substring of the matched spine original text', () => {
    const spines: SpineText[] = [
      { spineIndex: 0, text: 'Filler text that should not win the match under any reasonable scoring.' },
      { spineIndex: 3, text: 'Across the frozen fjord the sled dogs strained against their harnesses, breath steaming in the dark.' },
    ];
    const result = matchTranscript('the sled dogs strained against their harnesses breath steaming in the dark', spines);

    expect(result).not.toBeNull();
    expect(result!.spineIndex).toBe(3);
    expect(spines[1]!.text.includes(result!.phrase)).toBe(true);
  });

  it('handles empty inputs without throwing', () => {
    expect(matchTranscript('anything at all here', [])).toBeNull();
    expect(matchTranscript('   ', [{ spineIndex: 0, text: 'some text' }])).toBeNull();
  });
});

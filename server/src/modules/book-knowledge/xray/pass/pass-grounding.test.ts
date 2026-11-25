import { describe, expect, it } from 'vitest';
import { ungroundedNames } from './pass-grounding';

describe('ungroundedNames', () => {
  const support = ['Viv reached rank three of the hedge witch path.', 'She bound the war golem Solfis.'];

  it('passes a line built from what it was given', () => {
    expect(ungroundedNames('A hedge witch of rank three who bound the war golem Solfis.', support)).toEqual([]);
  });

  it('names the capitalised names nothing given mentions', () => {
    expect(ungroundedNames('A hedge witch exploring Cassian springs with Ilsa.', support)).toEqual(['Cassian', 'Ilsa']);
  });

  it('leaves lowercase words alone, however rare', () => {
    expect(ungroundedNames('A hedge witch exploring springs with millipedes, wielding obsidian.', support)).toEqual([]);
  });

  it('ignores the capital that opens the line', () => {
    expect(ungroundedNames('Young woman who travels south.', support)).toEqual([]);
  });

  it('matches word forms and possessives', () => {
    expect(ungroundedNames("A witch bound to Solfis's core, binding golems.", ['Solfis binds the golem core.', 'witch'])).toEqual([]);
  });
});

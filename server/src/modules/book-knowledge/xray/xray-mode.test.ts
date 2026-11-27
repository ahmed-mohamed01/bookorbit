import type { Sentence } from '../core/model';
import { modeFromSubjects, modeOpening, modeUser, parseModeAnswer, resolveMode } from './xray-mode';

const sentence = (ordinal: number, text: string, structure: Sentence['structure'] = 'body', heading = false): Sentence => ({
  ordinal,
  spineIndex: 0,
  paragraphIndex: ordinal,
  href: 's.xhtml',
  text,
  structure,
  heading,
  emphasis: [],
});

describe('parseModeAnswer', () => {
  it.each([
    [{ mode: 'fiction' }, 'fiction'],
    [{ mode: 'nonfiction' }, 'nonfiction'],
    [{ mode: 'Non-Fiction' }, 'nonfiction'],
    [{ mode: ' non fiction ' }, 'nonfiction'],
    [{ mode: 'poetry' }, null],
    [{ mode: 3 }, null],
    [{}, null],
    [['fiction'], null],
    ['fiction', null],
    [null, null],
  ])('reads %j as %s', (value, expected) => {
    expect(parseModeAnswer(value)).toBe(expected);
  });
});

describe('resolveMode', () => {
  it('prefers the override, then the model answer, then the subjects', () => {
    expect(resolveMode('fiction', 'nonfiction', ['History'])).toEqual({ mode: 'fiction', source: 'override' });
    expect(resolveMode(undefined, 'nonfiction', ['Fantasy'])).toEqual({ mode: 'nonfiction', source: 'model' });
    expect(resolveMode(undefined, null, ['History'])).toEqual({ mode: 'nonfiction', source: 'subjects' });
    expect(resolveMode(undefined, null, [])).toEqual({ mode: 'fiction', source: 'subjects' });
  });

  it('keeps the subject rule for the fallback', () => {
    expect(modeFromSubjects(['Fiction', 'History'])).toBe('fiction');
    expect(modeFromSubjects(['Nonfiction'])).toBe('nonfiction');
  });
});

describe('modeOpening', () => {
  it('skips front matter and headings and stops at the word cap', () => {
    const long = Array.from({ length: 600 }, () => 'word').join(' ');
    const sentences = [
      sentence(1, 'Copyright notice for the edition.', 'front'),
      sentence(2, 'Chapter One', 'body', true),
      ...Array.from({ length: 6 }, (_, index) => sentence(index + 3, long)),
    ];
    expect(modeOpening(sentences).map(({ ordinal }) => ordinal)).toEqual([3, 4, 5, 6]);
  });

  it('keeps a first sentence longer than the cap', () => {
    expect(modeOpening([sentence(1, Array.from({ length: 3000 }, () => 'w').join(' '))])).toHaveLength(1);
  });
});

describe('modeUser', () => {
  it('names the book, strips the blurb markup and adds the opening', () => {
    const user = modeUser(
      { title: 'Harrow Lane', authors: ['Mira Okonjo'], description: '<p>A family&#39;s<br/>last summer.</p>', subjects: ['Memoir'] },
      [sentence(1, 'The bus left without us.'), sentence(2, 'We walked.')],
    );
    expect(user).toContain('Title: Harrow Lane');
    expect(user).toContain('Author: Mira Okonjo');
    expect(user).toContain('Subjects: Memoir');
    expect(user).toContain("Description: A family's last summer.");
    expect(user).toContain('The bus left without us. We walked.');
  });

  it('says what is missing', () => {
    const user = modeUser({ title: null, authors: [], description: null, subjects: [] }, []);
    expect(user).toContain('Title: unknown');
    expect(user).toContain('Subjects: none');
    expect(user).toContain('Description: none');
  });
});

import { describe, it, expect } from 'vitest';
import { Uint8ArrayWriter, ZipWriter, TextReader } from '@zip.js/zip.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractEpubText } from './epub-text';
import { extractTerms, extractAliasLinks, termKey } from './term-extractor';
import {
  visibleTerms,
  visibleTerm,
  activeAliases,
  histogram,
  latestOccurrence,
  oftenWith,
  writeArtifact,
  readArtifact,
  ArtifactCache,
  deltaEncode,
  deltaDecode,
  displaySpelling,
} from './artifact';
import { fractionToOrdinal, checkpoints, cardCutoff } from './cutoff';
import { rankTerms } from './term-ranking';
import { selectEvidence } from './evidence';
import { buildArtifact, resolveTermWorkerPath } from './build-pipeline';
import type { Artifact, Sentence } from './model';
import { ARTIFACT_VERSION } from './versions';

async function epub(documents: { name: string; title: string; html: string; mediaType?: string }[]): Promise<Buffer> {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await writer.add(
    'META-INF/container.xml',
    new TextReader('<container><rootfiles><rootfile full-path="EPUB/package.opf"/></rootfiles></container>'),
  );
  await writer.add(
    'EPUB/package.opf',
    new TextReader(
      `<package><manifest>${documents.map((doc, i) => `<item id="c${i}" href="${doc.name}" media-type="${doc.mediaType ?? 'application/xhtml+xml'}"/>`).join('')}<item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/></manifest><spine>${documents.map((_, i) => `<itemref idref="c${i}"/>`).join('')}</spine></package>`,
    ),
  );
  await writer.add(
    'EPUB/nav.xhtml',
    new TextReader(`<html><body><nav>${documents.map((doc) => `<a href="${doc.name}">${doc.title}</a>`).join('')}</nav></body></html>`),
  );
  for (const doc of documents) await writer.add(`EPUB/${doc.name}`, new TextReader(`<html><body>${doc.html}</body></html>`));
  return Buffer.from(await writer.close());
}
async function fixture(): Promise<Buffer> {
  return epub([
    { name: 'contents.xhtml', title: 'Contents', html: '<p>Vesper lattice. Hidden future.</p>' },
    { name: 'part.xhtml', title: 'Part One', html: '<a id="part"><h1>Part One</h1></a>' },
    {
      name: 'index_split_001.xhtml',
      title: 'First',
      html: "<p>A lumen lattice is a folded memory engine. The lumen lattice stores quiet echoes.<sup><a>99</a></sup> Its blue shell hums softly.</p><p>The whole brain emulation operates slowly. Whole brain emulations preserve echoes. Stochastic gradient descent improves gradient descent.</p><p>A polis holds (aside) that echoes matter. The polises shelter a gleisner. The gleisners gather.</p><p>Ve saw ver and vis. Ve'd remember vis.</p>",
    },
    {
      name: 'two.xhtml',
      title: 'Second',
      html: '<p>A vesper lattice glows brightly. The lumen lattice is also known as the vesper lattice. The lumen lattice now stores a different signal.</p>',
    },
    { name: 'notes.xhtml', title: 'Notes', html: '<p>Lumen lattice. Lumen lattice.</p>' },
    { name: 'bibliography.xhtml', title: 'Bibliography', html: '<p>Imaginary reference.</p>' },
    { name: 'index.xhtml', title: 'Index', html: '<p>Indexonly engine. Indexonly engine. Lumen lattice, 1, 2, 3.</p>' },
  ]);
}
async function makeArtifact(): Promise<Artifact> {
  const text = await extractEpubText(await fixture());
  const terms = extractTerms(text.sentences);
  return {
    ...text,
    terms,
    aliasLinks: extractAliasLinks(text.sentences, terms),
    formatVersion: ARTIFACT_VERSION,
    textVersion: 1,
    termsVersion: 1,
    fingerprint: 'a'.repeat(64),
  };
}

describe('deterministic concept index', () => {
  it('parses spine order, excludes back matter and contents, preserves part titles and strips markers', async () => {
    const artifact = await makeArtifact();
    expect(artifact.sentences[0].structure).toBe('contents');
    expect(artifact.sentences.find((sentence) => sentence.text === 'Part One')?.structure).toBe('body');
    expect(artifact.sentences.map((sentence) => sentence.text).join(' ')).not.toContain('99');
    expect(artifact.sentences.filter((sentence) => ['notes', 'bibliography', 'index'].includes(sentence.structure))).toHaveLength(6);
    expect(artifact.terms.some((term) => term.key.includes('indexonly'))).toBe(false);
    expect(artifact.terms.some((term) => term.key.includes('hidden'))).toBe(false);
    expect(artifact.seeds).toHaveLength(2);
  });

  it('counts non-HTML itemrefs in sentence spine indices', async () => {
    const text = await extractEpubText(
      await epub([
        { name: 'cover.svg', title: 'Cover', html: '', mediaType: 'image/svg+xml' },
        { name: 'one.xhtml', title: 'First', html: '<p>A quiet engine hums.</p>' },
      ]),
    );
    expect(text.sentences).toHaveLength(1);
    expect(text.sentences[0].spineIndex).toBe(1);
  });

  it('keeps modifiers and nested phrases separate, normalizes only the last word, filters pronouns', async () => {
    const artifact = await makeArtifact();
    const keys = artifact.terms.map((term) => term.key);
    expect(keys).toContain('whole brain emulation');
    expect(keys).toContain('stochastic gradient descent');
    expect(keys).toContain('gradient descent');
    expect(keys).toContain('polis');
    expect(keys).toContain('gleisner');
    expect(termKey('whole brain emulations')).toBe('whole brain emulation');
    expect(visibleTerm(artifact, 'gleisner', Infinity)?.count).toBe(2);
    expect(keys.some((key) => /\b(ve|ver|vis)\b/.test(key))).toBe(false);
  });

  it('does not reveal a late alias or merge before the identity statement', async () => {
    const artifact = await makeArtifact();
    const firstLate = artifact.sentences.find((sentence) => sentence.text.startsWith('A vesper'))!.ordinal;
    const link = artifact.aliasLinks.find((link) => link.left === 'lumen lattice' && link.right === 'vesper lattice');
    expect(link).toBeDefined();
    expect(visibleTerm(artifact, 'vesper lattice', firstLate - 1)).toBeUndefined();
    expect(activeAliases(artifact, 'lumen lattice', firstLate - 1).some((alias) => /vesper/i.test(alias))).toBe(false);
    expect(visibleTerm(artifact, 'lumen lattice', firstLate)?.aliases.some((alias) => /vesper/i.test(alias))).toBe(false);
    expect(visibleTerm(artifact, 'lumen lattice', link!.ordinal)?.aliases.some((alias) => /vesper/i.test(alias))).toBe(true);
  });

  it('keeps whole paragraphs, first and latest evidence, and never crosses the cut-off', async () => {
    const artifact = await makeArtifact();
    const cutoff = artifact.sentences.find((sentence) => sentence.text.startsWith('The lumen lattice now'))!.ordinal;
    const passages = selectEvidence(artifact, 'lumen lattice', cutoff);
    const term = visibleTerm(artifact, 'lumen lattice', cutoff)!;
    expect(passages[0].ordinals).toContain(term.first);
    expect(passages.at(-1)!.ordinals).toContain(term.latest);
    expect(passages[0].text).toContain('Its blue shell hums softly.');
    for (let cut = 0; cut <= cutoff; cut++) {
      for (const term of visibleTerms(artifact, cut)) {
        expect(term.mentions.every((mention) => mention.ordinal <= cut)).toBe(true);
        expect(latestOccurrence(artifact, term.key, cut)!.ordinal).toBeLessThanOrEqual(cut);
        expect(histogram(artifact, term.key, cut).reduce((sum, chapter) => sum + chapter.count, 0)).toBe(term.count);
        expect(oftenWith(artifact, term.key, cut).every((related) => related.first <= cut)).toBe(true);
        expect(selectEvidence(artifact, term.key, cut).every((passage) => passage.ordinals.every((ordinal) => ordinal <= cut))).toBe(true);
      }
    }
    const early = selectEvidence(artifact, 'lumen lattice', artifact.sentences.find((sentence) => sentence.text.startsWith('The whole'))!.ordinal);
    expect(early.some((passage) => /vesper/i.test(passage.text))).toBe(false);
  });

  it('ranks a rare defined term above a frequent common noun using only seen features', async () => {
    const text = await extractEpubText(
      await epub([
        { name: 'one.xhtml', title: 'First', html: `<p>A glimmerfold is a sealed echo engine.</p>${'<p>A reason guides a reason.</p>'.repeat(30)}` },
      ]),
    );
    const artifact: Artifact = {
      ...text,
      terms: extractTerms(text.sentences),
      aliasLinks: [],
      formatVersion: 1,
      textVersion: 1,
      termsVersion: 1,
      fingerprint: '',
    };
    const ranked = rankTerms(artifact, Infinity);
    expect(ranked.find((term) => term.key === 'glimmerfold')!.score).toBeGreaterThan(ranked.find((term) => term.key === 'reason')?.score ?? 0);
    const cutoff = text.sentences[0].ordinal;
    const before = rankTerms(artifact, cutoff);
    const prefix = {
      ...artifact,
      sentences: artifact.sentences.filter((sentence) => sentence.ordinal <= cutoff),
      terms: extractTerms(text.sentences.filter((sentence) => sentence.ordinal <= cutoff)),
    };
    expect(before).toEqual(rankTerms(prefix, cutoff));
  });

  it('handles abbreviation sentence boundaries and hyphenated forms', async () => {
    const text = await extractEpubText(
      await epub([{ name: 'one.xhtml', title: 'First', html: '<p>Dr. Nara built a memory-shell. The memory-shell is a quiet engine.</p>' }]),
    );
    expect(text.sentences).toHaveLength(2);
    expect(extractTerms(text.sentences).some((term) => term.key === 'memory-shell')).toBe(true);
  });

  it('filters a statistical invented pronoun using only occurrences already seen', () => {
    const sentences: Sentence[] = Array.from({ length: 15 }, (_, index) => ({
      ordinal: index + 1,
      spineIndex: 0,
      paragraphIndex: index,
      href: 'one.xhtml',
      text: 'zim sees a shell.',
      structure: 'body',
      heading: false,
      emphasis: [],
    }));
    const artifact: Artifact = {
      sentences,
      seeds: [],
      terms: extractTerms(sentences),
      aliasLinks: [],
      formatVersion: 1,
      textVersion: 1,
      termsVersion: 1,
      fingerprint: '',
    };
    expect(visibleTerm(artifact, 'zim', 1)).toBeDefined();
    expect(visibleTerm(artifact, 'zim', 15)).toBeUndefined();
  });

  it('trims long evidence at whole sentences while retaining first and latest chapters', async () => {
    const text = await extractEpubText(
      await epub([
        {
          name: 'one.xhtml',
          title: 'First',
          html: `<p>A lumen lattice is a folded echo engine. ${'A quiet shell emits a soft signal. '.repeat(30)}</p>`,
        },
        {
          name: 'two.xhtml',
          title: 'Second',
          html: `<p>${'A quiet shell emits a soft signal. '.repeat(30)}The lumen lattice stores a changed signal.</p>`,
        },
      ]),
    );
    const artifact: Artifact = {
      ...text,
      terms: extractTerms(text.sentences),
      aliasLinks: [],
      formatVersion: 1,
      textVersion: 1,
      termsVersion: 1,
      fingerprint: '',
    };
    const passages = selectEvidence(artifact, 'lumen lattice', Infinity, { maxWords: 60 });
    const term = visibleTerm(artifact, 'lumen lattice', Infinity)!;
    expect(passages).toHaveLength(2);
    expect(passages[0].ordinals).toContain(term.first);
    expect(passages[1].ordinals).toContain(term.latest);
    expect(passages.flatMap((passage) => passage.text.split(/\s+/)).length).toBeLessThanOrEqual(60);
    for (const passage of passages) expect(passage.text).toBe(passage.ordinals.map((ordinal) => artifact.sentences[ordinal - 1].text).join(' '));
  });

  it('recognizes captions and does not use future definitions in rank', async () => {
    const text = await extractEpubText(
      await epub([
        {
          name: 'one.xhtml',
          title: 'First',
          html: '<figure><figcaption>Figure 1</figcaption></figure><p>A glimmerfold hums quietly.</p><p>The glimmerfold is a sealed engine.</p>',
        },
      ]),
    );
    const artifact: Artifact = {
      ...text,
      terms: extractTerms(text.sentences),
      aliasLinks: [],
      formatVersion: 1,
      textVersion: 1,
      termsVersion: 1,
      fingerprint: '',
    };
    expect(text.sentences[0].caption).toBe(true);
    expect(rankTerms(artifact, Infinity).some((term) => term.key === 'figure')).toBe(false);
    const first = text.sentences.find((sentence) => sentence.text.startsWith('A glimmerfold'))!.ordinal;
    const early = rankTerms(artifact, first).find((term) => term.key === 'glimmerfold')!;
    const late = rankTerms(artifact, Infinity).find((term) => term.key === 'glimmerfold')!;
    expect(early.mentions.some((mention) => mention.definition)).toBe(false);
    expect(late.score).toBeGreaterThan(early.score);
  });

  it('uses all spine characters, round-down cutoffs, chapter and 200-sentence checkpoints', () => {
    const sentences: Sentence[] = Array.from({ length: 405 }, (_, i) => ({
      ordinal: i + 1,
      spineIndex: i < 250 ? 0 : 1,
      paragraphIndex: i,
      href: 'one.xhtml',
      text: '1234',
      structure: i === 0 ? 'contents' : 'body',
      heading: false,
      emphasis: [],
    }));
    expect(fractionToOrdinal(sentences, 0)).toBe(0);
    expect(fractionToOrdinal(sentences, 1)).toBe(405);
    expect(fractionToOrdinal(sentences, 0.5)).toBe(202);
    expect(checkpoints(sentences)).toEqual([201, 250, 401, 405]);
    expect(cardCutoff(sentences, 275, 260)).toBe(260);
    expect(cardCutoff(sentences, 275, 20)).toBe(250);
  });

  it('round-trips delta and atomic gzip formats and bounds the LRU by bytes', async () => {
    expect(deltaEncode([1, 1, 9, 25])).toEqual([1, 0, 8, 16]);
    expect(deltaDecode([1, 0, 8, 16], 9)).toEqual([1, 1, 9]);
    const directory = await mkdtemp(join(tmpdir(), 'knowledge-test-'));
    try {
      await expect(readArtifact(join(directory, 'missing.gz'))).rejects.toThrow();
      const artifact = await makeArtifact();
      const path = join(directory, 'artifact.gz');
      await writeArtifact(path, artifact);
      expect(await readArtifact(path)).toEqual(artifact);
      const withVotes = { ...artifact, formatVersion: ARTIFACT_VERSION, modelVotes: [{ key: 'lumen lattice', deltas: [2, 1] }] };
      await writeArtifact(path, withVotes);
      expect(await readArtifact(path)).toEqual(withVotes);
      await expect(readArtifact(path, 1)).rejects.toThrow('exceeds');
      const cache = new ArtifactCache();
      for (const key of ['a', 'b', 'c']) cache.set(key, artifact, 100 * 1024 * 1024);
      cache.get('a');
      cache.set('d', artifact, 100 * 1024 * 1024);
      expect(cache.get('b')).toBeUndefined();
      expect(cache.get('a')).toBe(artifact);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('builds from a real worker with the source file fingerprint', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'knowledge-worker-'));
    try {
      const path = join(directory, 'fixture.epub');
      await writeFile(path, await fixture());
      expect(resolveTermWorkerPath()).toMatch(/term-extractor.worker\.(ts|js)$/);
      const result = await buildArtifact(path, {
        outputPath: join(directory, 'artifact.gz'),
        cacheDirectory: directory,
        gliner: { directory: join(directory, 'missing-model') },
      });
      expect(result.artifact.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(result.artifactBytes).toBeGreaterThan(0);
      expect(result.artifact).not.toHaveProperty('modelVotes');
      expect(result.stageMs.terms).toBeGreaterThan(0);
      expect(result.reused).toEqual({ text: false, gliner: false, terms: false });
      const reused = await buildArtifact(path, { cacheDirectory: directory });
      expect(reused.reused).toEqual({ text: true, gliner: false, terms: true });
      expect(reused.artifact).toEqual(result.artifact);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
it('attributes emphasis only to the containing sentence', async () => {
  const text = await extractEpubText(
    await epub([
      {
        name: 'body.xhtml',
        title: 'First',
        html: '<p>The lumen lattice stores quiet echoes. We inspect the <em>lumen lattice</em> closely.</p><p><em>The copper net hums. The copper net rests.</em></p>',
      },
    ]),
  );
  expect(text.sentences.map((s) => s.emphasis)).toEqual([[], ['lumen lattice'], [], []]);
  const term = extractTerms(text.sentences).find((term) => term.key === 'lumen lattice')!;
  expect(term.features[0].definition).toBe(false);
  expect(term.features[1].definition).toBe(true);
});
it('memoizes immutable visibility at exact cutoffs with bounded retention', async () => {
  const artifact = await makeArtifact();
  const first = visibleTerms(artifact, 5);
  expect(visibleTerms(artifact, 5)).toBe(first);
  expect(Object.isFrozen(first)).toBe(true);
  expect(Object.isFrozen(first[0].mentions[0])).toBe(true);
  expect(visibleTerms(artifact, 6)).not.toBe(first);
  for (let cutoff = 7; cutoff < 16; cutoff++) visibleTerms(artifact, cutoff);
  expect(visibleTerms(artifact, 5)).not.toBe(first);
});

describe('display spelling', () => {
  const pick = (counts: [string, number][]) =>
    displaySpelling(
      new Map(counts),
      counts.map(([spelling]) => spelling),
    );

  it('title-cases a name the book only capitalises when shouting or glitching', () => {
    expect(
      pick([
        ['IMPERIAL FAMILY', 4],
        ['imperial family', 3],
        ['ImperIaL FAMILY', 1],
      ]),
    ).toBe('Imperial Family');
    expect(pick([['CROWN OF THE OLD EMPIRE', 1]])).toBe('Crown of the Old Empire');
  });

  it('keeps plain names, one inner capital and a mostly lowercase word', () => {
    expect(
      pick([
        ['Viv', 9],
        ['VIV', 2],
      ]),
    ).toBe('Viv');
    expect(pick([['McAllister', 3]])).toBe('McAllister');
    expect(
      pick([
        ['golem', 9],
        ['GOLEM', 1],
      ]),
    ).toBe('golem');
  });
});

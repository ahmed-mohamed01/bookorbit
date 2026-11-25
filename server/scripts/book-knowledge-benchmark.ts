import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { buildArtifact } from '../src/modules/book-knowledge/core/build-pipeline';
import { fractionToOrdinal } from '../src/modules/book-knowledge/core/cutoff';
import { rankTerms } from '../src/modules/book-knowledge/core/term-ranking';
import { visibleTerms, oftenWith, visibleTerm } from '../src/modules/book-knowledge/core/artifact';
import { selectEvidence } from '../src/modules/book-knowledge/core/evidence';
import { termKey } from '../src/modules/book-knowledge/core/text-utils';
import type { Artifact } from '../src/modules/book-knowledge/core/model';

// Usage: tsx scripts/book-knowledge-benchmark.ts [--labels /private/labels.json] book.epub ...
// Labels: { books: [{ path, relevant: [term], mustFind: [term], cutoffs: [0.25, 0.5, 1] }] }
interface Labels {
  books: { path: string; relevant?: string[]; mustFind?: string[]; cutoffs?: number[] }[];
}
function assert(condition: unknown, check = 'unspecified'): asserts condition {
  if (!condition) throw new Error(`Cut-off leak detected: ${check}`);
}
export function checkLeaks(artifact: Artifact, cutoff: number, selected?: Set<string>): number {
  const terms = visibleTerms(artifact, cutoff);
  let checks = 0;
  for (const term of terms) {
    assert(term.first <= cutoff && term.latest <= cutoff, 'term-range');
    for (const mention of term.mentions) {
      assert(mention.ordinal <= cutoff, 'mention');
      checks++;
    }
    for (const alias of term.aliases) {
      assert(
        term.mentions.some((mention) => mention.alias === alias && mention.ordinal <= cutoff),
        'alias',
      );
      checks++;
    }
    if (selected && !selected.has(term.key)) continue;
    for (const related of oftenWith(artifact, term.key, cutoff)) {
      assert(related.first <= cutoff && visibleTerm(artifact, related.key, cutoff), 'relation');
      checks++;
    }
    for (const passage of selectEvidence(artifact, term.key, cutoff)) {
      assert(
        passage.ordinals.every((ordinal) => ordinal <= cutoff),
        'passage-range',
      );
      assert(passage.text === passage.ordinals.map((ordinal) => artifact.sentences[ordinal - 1].text).join(' '), 'passage-text');
      checks++;
    }
  }
  return checks;
}
function plantedAliasCheck(): void {
  const artifact: Artifact = {
    formatVersion: 1,
    textVersion: 1,
    termsVersion: 1,
    fingerprint: '',
    seeds: [],
    sentences: [],
    terms: ['lumen', 'vesper'].map((key, index) => ({
      key,
      rarity: 1,
      wordCount: 1,
      deltas: [index ? 80 : 1],
      features: [{ alias: key, definition: true, capitalized: false, person: false, place: false, nested: false, structural: false }],
    })),
    aliasLinks: [{ left: 'lumen', right: 'vesper', ordinal: 90 }],
  };
  assert(visibleTerms(artifact, 50).length === 1);
  assert(visibleTerms(artifact, 50)[0].displayName === 'lumen' && visibleTerms(artifact, 50)[0].aliases.length === 0);
  assert(visibleTerms(artifact, 85).length === 2);
  assert(
    visibleTerms(artifact, 90).length === 1 &&
      new Set([visibleTerms(artifact, 90)[0].displayName, ...visibleTerms(artifact, 90)[0].aliases]).size === 2,
  );
}
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const index = args.indexOf('--labels');
  let labels: Labels = { books: [] };
  if (index >= 0) {
    labels = JSON.parse(await readFile(args[index + 1], 'utf8')) as Labels;
    args.splice(index, 2);
  }
  if (!args.length) throw new Error('Supply at least one EPUB path');
  plantedAliasCheck();
  const topN = Number(process.env.BK_TOP_N ?? 30);
  const maxLeakTerms = Number(process.env.BK_LEAK_TERMS ?? 100);
  const timeoutMs = Number(process.env.BK_TIMEOUT_MS ?? 180000);
  const results: unknown[] = [];
  const directory = await mkdtemp(join(tmpdir(), 'book-knowledge-'));
  try {
    for (let index = 0; index < args.length; index++) {
      const start = performance.now();
      const result = await buildArtifact(resolve(args[index]), { outputPath: join(directory, `${index}.gz`), timeoutMs });
      const totalBuildMs = performance.now() - start;
      assert(result.artifact.terms.length > 0, 'empty-build');
      const bookLabels = labels.books.find((book) => resolve(book.path) === resolve(args[index]));
      const cutoffs = bookLabels?.cutoffs ?? [0, 0.25, 0.5, 0.75, 1];
      const measurements = cutoffs.map((fraction) => {
        const cutoff = fractionToOrdinal(result.artifact.sentences, fraction);
        const ranked = rankTerms(result.artifact, cutoff);
        const relevant = new Set((bookLabels?.relevant ?? []).map(termKey));
        const ranks = (bookLabels?.mustFind ?? []).map((term) => {
          const index = ranked.findIndex(
            (candidate) => candidate.key === termKey(term) || candidate.aliases.some((alias) => termKey(alias) === termKey(term)),
          );
          return index < 0 ? null : index + 1;
        });
        // Full term/alias validation is cheap. Expensive passage and relation checks are bounded.
        for (const term of visibleTerms(result.artifact, cutoff)) {
          assert(
            term.mentions.every((mention) => mention.ordinal <= cutoff),
            'alias',
          );
          assert(term.aliases.every((alias) => term.mentions.some((mention) => mention.alias === alias)));
        }
        const subset = new Set(ranked.slice(0, maxLeakTerms).map((term) => term.key));
        const leakChecks = checkLeaks(result.artifact, cutoff, subset);
        return {
          fraction,
          cutoff,
          visibleTerms: ranked.length,
          precisionAtN: relevant.size
            ? ranked.slice(0, topN).filter((term) => relevant.has(term.key)).length / Math.max(1, Math.min(topN, ranked.length))
            : null,
          mustFindRanks: ranks,
          mustFindRecall: ranks.length ? ranks.filter((rank) => rank !== null).length / ranks.length : null,
          leakChecks,
        };
      });
      results.push({
        book: index + 1,
        stageMs: result.stageMs,
        totalBuildMs,
        stagePeakRssBytes: result.stagePeakRssBytes,
        peakRssBytes: result.peakRssBytes,
        sentenceCount: result.artifact.sentences.length,
        termCount: result.artifact.terms.length,
        artifactBytes: result.artifactBytes,
        cutoffs: measurements,
      });
    }
    console.log(JSON.stringify({ topN, maxLeakTerms, plantedAliasCheck: 'passed', books: results }, null, 2));
    console.error(`Built ${results.length} book(s); leak checks passed. Metrics contain counts only.`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
if (require.main === module)
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Benchmark failed');
    process.exitCode = 1;
  });

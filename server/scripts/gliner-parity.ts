import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createGlinerRunner } from '../src/modules/book-knowledge/gliner/runner';
import { GLINER_LABELS, GLINER_THRESHOLD, type GlinerSpan } from '../src/modules/book-knowledge/gliner/protocol';

const sentences = [
  'Ada Lovelace studied the analytical engine.',
  'Cognitive science investigates the nature of memory.',
  'Utilitarianism treats pleasure as a measure of welfare.',
  'The simulation hypothesis questions the nature of reality.',
  'Ada argued that the experience machine cannot confer meaning.',
  'Quantum computing promises new tools for cryptography.',
  'The engineer tested a carbon-fiber prosthesis.',
  'Peer described a world of digital minds and virtual reality.',
  'The prisoner’s dilemma illustrates the limits of cooperation.',
  'Schopenhauer saw boredom as a consequence of satisfied desire.',
  'Eleanor Rigby listened to a clock that never chimed.',
  'Synthetic biology draws methods from electrical engineering.',
  'We compared the steady-state theory with the Big Bang theory.',
  'Artificial general intelligence remains a research goal.',
  'The cabinet sheltered a radio, a spool of wire, and three small stones.',
  'The astronomer used adaptive optics to resolve a distant star.',
  'Under ideal conditions, the law of large numbers predicts convergence.',
  'The old airship shuddered as Mara adjusted the ballast.',
  'Embodied cognition gives the body a role in thinking.',
  'A self-replicating probe could cross the galaxy.',
  'A post-scarcity society might still struggle with fulfillment.',
  'Before dawn, the porch was quiet.',
  'Do these choices have intrinsic value?',
  'Jean-Luc spoke to Élodie about the Turing test.',
  '🧪  Café workers set a quartz clock beside a paper lantern.',
  'Gödel’s incompleteness theorem changed mathematical logic.',
  'The town invested in solar panels, then in pumped hydro storage.',
  'She developed a theory of moral luck after leaving the institute.',
  'A １２-hour cycle and a fullwidth underscore ＿ confused the interface.',
  'Socio_economic models differ in how they treat public goods.',
];

async function main(): Promise<void> {
  const [directoryArg, python, onnxFile = 'onnx/model.onnx'] = process.argv.slice(2);
  if (!directoryArg || !python)
    throw new Error('Usage: tsx scripts/gliner-parity.ts <model directory> <python> [onnx file relative to model directory]');
  const directory = resolve(directoryArg);
  const modelPath = join(directory, onnxFile);
  const reference = spawnSync(python, ['-I', join(__dirname, 'gliner-parity.py'), directory, modelPath], {
    input: JSON.stringify({ sentences, labels: GLINER_LABELS, threshold: GLINER_THRESHOLD }),
    encoding: 'utf8',
    env: { ...process.env, HF_HUB_OFFLINE: '1' },
  });
  if (reference.error) throw reference.error;
  if (reference.status !== 0) throw new Error(reference.stderr);
  const expected = JSON.parse(reference.stdout) as { ids: number[]; wordsMask: number[]; spans: GlinerSpan[] }[];
  const runner = await createGlinerRunner(directory, modelPath);
  let totalSpans = 0;
  let maxDifference = 0;
  try {
    for (const [i, sentence] of sentences.entries()) {
      const input = await runner.prepareInput(sentence, GLINER_LABELS);
      assert.deepEqual(input?.ids, expected[i].ids, `Token IDs in sentence ${i + 1}`);
      assert.deepEqual(input?.wordsMask, expected[i].wordsMask, `Word mask in sentence ${i + 1}`);
      const actual = await runner.predict(sentence, GLINER_LABELS, GLINER_THRESHOLD);
      assert.equal(actual.length, expected[i].spans.length, `Span count in sentence ${i + 1}`);
      for (const [j, span] of actual.entries()) {
        const other = expected[i].spans[j];
        assert.deepEqual(
          [Array.from(sentence.slice(0, span.start)).length, Array.from(sentence.slice(0, span.end)).length, span.text, span.label],
          [other.start, other.end, other.text, other.label],
          `Span ${j + 1} in sentence ${i + 1}`,
        );
        const difference = Math.abs(span.score - other.score);
        assert.ok(difference <= 0.02, `Score difference ${difference} in sentence ${i + 1}`);
        maxDifference = Math.max(maxDifference, difference);
        totalSpans++;
      }
    }
  } finally {
    await runner.release();
  }
  assert.ok(totalSpans > 0);
  console.log(`${sentences.length} matching inputs, ${totalSpans} matching spans and labels, max score difference ${maxDifference.toFixed(8)}`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

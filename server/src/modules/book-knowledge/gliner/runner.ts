import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { InferenceSession, Tensor } from 'onnxruntime-node';
import { Tokenizer } from 'tokenizers';
import { z } from 'zod';

import { PYTHON_NON_SPACE, type GlinerRunner, type GlinerSpan } from './protocol';

const configSchema = z.object({
  ent_token: z.string(),
  sep_token: z.string(),
  max_len: z.number().int().positive(),
  max_width: z.number().int().positive(),
  subtoken_pooling: z.literal('first'),
  words_splitter_type: z.literal('whitespace'),
});

type GlinerConfig = z.infer<typeof configSchema>;
const wordPattern = new RegExp(String.raw`[\p{L}\p{N}_]+(?:[-_][\p{L}\p{N}_]+)*|${PYTHON_NON_SPACE.source}`, 'gu');

function splitWords(text: string) {
  return Array.from(text.matchAll(wordPattern), (match) => ({
    text: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));
}

function int64(values: number[], dims: number[]): Tensor {
  return new Tensor('int64', BigInt64Array.from(values, BigInt), dims);
}

function decode(
  logits: Float32Array,
  text: string,
  words: ReturnType<typeof splitWords>,
  width: number,
  labels: readonly string[],
  threshold: number,
): GlinerSpan[] {
  const candidates: { start: number; end: number; label: string; score: number }[] = [];
  for (let start = 0; start < words.length; start++) {
    for (let offset = 0; offset < width && start + offset < words.length; offset++) {
      for (let label = 0; label < labels.length; label++) {
        const score = Math.fround(1 / (1 + Math.exp(-logits[(start * width + offset) * labels.length + label])));
        if (score > threshold) candidates.push({ start, end: start + offset, label: labels[label], score });
      }
    }
  }

  const used = new Uint8Array(words.length);
  const selected: GlinerSpan[] = [];
  for (const span of candidates.sort((a, b) => b.score - a.score)) {
    if (used.subarray(span.start, span.end + 1).includes(1)) continue;
    used.fill(1, span.start, span.end + 1);
    const start = words[span.start].start;
    const end = words[span.end].end;
    selected.push({ start, end, text: text.slice(start, end), label: span.label, score: span.score });
  }
  return selected.sort((a, b) => a.start - b.start);
}

class OnnxGlinerRunner implements GlinerRunner {
  constructor(
    private readonly session: InferenceSession,
    private readonly tokenizer: Tokenizer,
    private readonly config: GlinerConfig,
    private readonly specialIds: number[],
  ) {}

  async prepareInput(text: string, labels: readonly string[]) {
    const words = splitWords(text).slice(0, this.config.max_len);
    if (words.length === 0 || labels.length === 0) return undefined;

    const prompt = labels.flatMap((label) => [this.config.ent_token, label]);
    prompt.push(this.config.sep_token);
    const encodings = await this.tokenizer.encodeBatch([...prompt, ...words.map((word) => word.text)], { addSpecialTokens: false });
    const ids = [this.specialIds[0]];
    const wordsMask = [0];
    for (const [index, encoding] of encodings.entries()) {
      const tokens = encoding.getIds();
      ids.push(...tokens);
      wordsMask.push(...tokens.map((_, i) => (index >= prompt.length && i === 0 ? index - prompt.length + 1 : 0)));
    }
    ids.push(this.specialIds[1]);
    wordsMask.push(0);
    return { words, ids, wordsMask };
  }

  async predict(text: string, labels: readonly string[], threshold: number): Promise<GlinerSpan[]> {
    const input = await this.prepareInput(text, labels);
    if (!input) return [];
    const { words, ids, wordsMask } = input;
    const width = this.config.max_width;
    const spanCount = words.length * width;
    const indices = new BigInt64Array(spanCount * 2);
    const mask = new Uint8Array(spanCount);
    for (let i = 0; i < spanCount; i++) {
      const start = Math.floor(i / width);
      const end = start + (i % width);
      indices[2 * i] = BigInt(start);
      indices[2 * i + 1] = BigInt(end);
      mask[i] = Number(end < words.length);
    }

    const { logits } = await this.session.run(
      {
        input_ids: int64(ids, [1, ids.length]),
        attention_mask: int64(
          ids.map(() => 1),
          [1, ids.length],
        ),
        words_mask: int64(wordsMask, [1, ids.length]),
        text_lengths: int64([words.length], [1, 1]),
        span_idx: new Tensor('int64', indices, [1, spanCount, 2]),
        span_mask: new Tensor('bool', mask, [1, spanCount]),
      },
      ['logits'],
    );
    if (!(logits.data instanceof Float32Array) || logits.data.length !== spanCount * labels.length) {
      throw new Error('Unexpected GLiNER logits shape');
    }
    return decode(logits.data, text, words, width, labels, threshold);
  }

  release(): Promise<void> {
    return this.session.release();
  }
}

export async function createGlinerRunner(directory: string, modelPath: string, threads = 2): Promise<OnnxGlinerRunner> {
  const [configJson, tokenizerJson, tokenizerConfigJson] = await Promise.all(
    ['gliner_config.json', 'tokenizer.json', 'tokenizer_config.json'].map((file) => readFile(join(directory, file), 'utf8')),
  );
  const config = configSchema.parse(JSON.parse(configJson));
  const tokenizerData = JSON.parse(tokenizerJson) as { normalizer: unknown };
  const tokenizerConfig = z.object({ do_lower_case: z.boolean().default(false) }).parse(JSON.parse(tokenizerConfigJson));
  // Python's DebertaV2Tokenizer replaces the normalizer serialized in tokenizer.json.
  tokenizerData.normalizer = {
    type: 'Sequence',
    normalizers: [
      ...(tokenizerConfig.do_lower_case ? [{ type: 'Lowercase' }] : []),
      { type: 'Replace', pattern: { Regex: '\\s{2,}|[\\n\\r\\t]' }, content: ' ' },
      { type: 'NFC' },
      { type: 'Strip', strip_left: false, strip_right: true },
    ],
  };
  const tokenizer = Tokenizer.fromString(JSON.stringify(tokenizerData));
  const specialIds = (await tokenizer.encode('')).getIds();
  if (specialIds.length !== 2) throw new Error('Unexpected GLiNER tokenizer special tokens');
  const session = await InferenceSession.create(modelPath, {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
    intraOpNumThreads: threads,
  });
  return new OnnxGlinerRunner(session, tokenizer, config, specialIds);
}

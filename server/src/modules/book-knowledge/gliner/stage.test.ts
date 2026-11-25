import { Logger } from '@nestjs/common';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Sentence } from '../core/model';
import { deltaDecode } from '../core/artifact';
import { KIND_LABELS } from '../core/kind-cues';
import { buildKindSpans } from './stage';
import { votesFromKindSpans } from './votes';

function sentence(ordinal: number, text: string, paragraphIndex = 0, structure: Sentence['structure'] = 'body'): Sentence {
  return { ordinal, text, paragraphIndex, structure, spineIndex: 0, href: 'invented.xhtml', heading: false, emphasis: [] };
}

function fakeRunner() {
  return {
    predict: vi.fn((text: string) =>
      Promise.resolve(
        Array.from(text.matchAll(/amber lattice/g), (match) => ({
          start: match.index,
          end: match.index + match[0].length,
          text: match[0],
          label: KIND_LABELS[0],
          score: 0.9,
        })),
      ),
    ),
    release: vi.fn(async () => {}),
  };
}

describe('GLiNER build stage', () => {
  it('derives a ranking vote only from labels inside the retired vote scope, usable from its window end', () => {
    const sentences = [sentence(1, 'The amber lattice hums.'), sentence(2, 'An Amber Lattice glows.', 1), sentence(3, 'The amber lattice fades.', 2)];
    const second = sentences[0].text.length + 1 + 3;
    const third = second - 3 + sentences[1].text.length + 1 + 4;
    const spans = [
      4,
      17,
      KIND_LABELS.indexOf('concept or idea'),
      1,
      second,
      second + 13,
      KIND_LABELS.indexOf('object or artifact'),
      2,
      third,
      third + 13,
      KIND_LABELS.indexOf('force or energy'),
      3,
    ];
    const votes = votesFromKindSpans(sentences, spans);
    expect(votes).toEqual([{ key: 'amber lattice', deltas: [1, 2] }]);
    expect(deltaDecode(votes[0].deltas, 2)).toEqual([1]);
    expect(deltaDecode(votes[0].deltas, 3)).toEqual([1, 3]);
  });

  it('skips a missing model and logs the disabled model once', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gliner-missing-'));
    const createRunner = vi.fn(() => Promise.resolve(fakeRunner()));
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    try {
      await expect(buildKindSpans([], { directory }, 1, directory, createRunner)).resolves.toEqual({ reused: false });
      await expect(buildKindSpans([], { directory }, 2, directory, createRunner)).resolves.toEqual({ reused: false });
      expect(createRunner).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('enabled=false'));
    } finally {
      log.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reuses the span cache and recomputes it when model files change', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gliner-cache-'));
    const runner = fakeRunner();
    const createRunner = vi.fn(() => Promise.resolve(runner));
    try {
      await Promise.all(
        ['model.onnx', 'gliner_config.json', 'tokenizer.json', 'tokenizer_config.json'].map((file) => writeFile(join(directory, file), '')),
      );
      const sentences = [sentence(1, 'The amber lattice hums.')];
      const spans = [4, 17, 0, 1];
      await expect(buildKindSpans(sentences, { directory }, 1, directory, createRunner)).resolves.toEqual({ spans, reused: false });
      await expect(buildKindSpans(sentences, { directory }, 1, directory, createRunner)).resolves.toEqual({ spans, reused: true });
      expect(createRunner).toHaveBeenCalledTimes(1);
      expect(runner.release).toHaveBeenCalledTimes(1);
      await writeFile(join(directory, 'model.onnx'), 'new revision');
      await expect(buildKindSpans(sentences, { directory }, 1, directory, createRunner)).resolves.toEqual({ spans, reused: false });
      expect(createRunner).toHaveBeenCalledTimes(2);
      expect(runner.release).toHaveBeenCalledTimes(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('gives up between windows once the deadline passes, with no spans and no cache', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gliner-deadline-'));
    const runner = fakeRunner();
    const createRunner = vi.fn(() => Promise.resolve(runner));
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    let clock = 0;
    const now = () => clock;
    try {
      await Promise.all(
        ['model.onnx', 'gliner_config.json', 'tokenizer.json', 'tokenizer_config.json'].map((file) => writeFile(join(directory, file), '')),
      );
      const sentences = [sentence(1, 'The amber lattice hums.')];
      createRunner.mockImplementation(() => {
        clock = 21 * 60_000;
        return Promise.resolve(runner);
      });
      await expect(buildKindSpans(sentences, { directory }, 1, directory, createRunner, now)).resolves.toEqual({ reused: false, timedOut: true });
      expect(runner.predict).not.toHaveBeenCalled();
      expect(runner.release).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('errorClass=GlinerDeadlineError'));
      clock = 0;
      createRunner.mockImplementation(() => Promise.resolve(runner));
      await expect(buildKindSpans(sentences, { directory }, 1, directory, createRunner, now)).resolves.toEqual({
        spans: [4, 17, 0, 1],
        reused: false,
      });
    } finally {
      warn.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

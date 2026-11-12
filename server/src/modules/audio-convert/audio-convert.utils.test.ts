import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AudioProbeCache, probeAudio, runConvertFfmpeg } from './audio-convert-ffmpeg';
import {
  buildConcatList,
  buildConvertArgs,
  buildFfmetadata,
  chooseAutoCodec,
  exactStartsMs,
  mapWithConcurrency,
  outputPathFor,
  perFileChapters,
  plainStartsSeconds,
  rebaseChapters,
  remapAbsoluteSeconds,
  resolveCodec,
  spreadBookmarkPositions,
  type AudioProbe,
  type ConvertArgsInput,
} from './audio-convert.utils';

const mp3 = (overrides: Partial<AudioProbe> = {}): AudioProbe => ({
  durationMs: 1000,
  codec: 'mp3',
  sampleRate: 44100,
  channels: 2,
  bitrateKbps: 64,
  ...overrides,
});

describe('chooseAutoCodec', () => {
  it('copies when every file matches', () => {
    expect(chooseAutoCodec([mp3(), mp3()])).toEqual({ codec: 'copy', reason: 'all_match' });
  });

  it.each([
    [{ codec: 'aac' }, 'mixed_codecs'],
    [{ sampleRate: 22050 }, 'mixed_sample_rates'],
    [{ channels: 1 }, 'mixed_channels'],
  ] as const)('encodes AAC when files differ (%o)', (override, reason) => {
    expect(chooseAutoCodec([mp3(), mp3(override)])).toEqual({ codec: 'aac', reason });
  });

  it('encodes AAC for codecs an MP4 cannot carry', () => {
    expect(chooseAutoCodec([mp3({ codec: 'opus' })]).codec).toBe('aac');
  });

  it('falls back from copy to AAC when the files cannot be joined by copying', () => {
    expect(resolveCodec('copy', [mp3(), mp3({ channels: 1 })])).toBe('aac');
    expect(resolveCodec('aac', [mp3()])).toBe('aac');
    expect(resolveCodec('auto', [mp3()])).toBe('copy');
  });
});

describe('timeline remapping', () => {
  // Stored lengths are whole seconds; the exact ones are a little shorter.
  const oldStarts = [0, 100, 200];
  const newStarts = exactStartsMs([99_600, 99_700, 50_000]).map((ms) => ms / 1000);

  it('keeps the offset into the same file', () => {
    expect(remapAbsoluteSeconds(150, oldStarts, newStarts)).toBeCloseTo(99.6 + 50);
    expect(remapAbsoluteSeconds(5, oldStarts, newStarts)).toBe(5);
    expect(remapAbsoluteSeconds(210, oldStarts, newStarts)).toBeCloseTo(199.3 + 10);
  });

  it('clamps an offset past the exact end of its file', () => {
    expect(remapAbsoluteSeconds(99.9, oldStarts, newStarts)).toBeCloseTo(99.6);
  });

  it('rebases chapters, keeping the first at zero and dropping ones past the end', () => {
    const chapters = rebaseChapters(
      [
        { title: 'One', startMs: 0 },
        { title: 'Two', startMs: 100_000 },
        { title: 'Three', startMs: 260_000 },
      ],
      oldStarts,
      newStarts,
      249_300,
    );
    expect(chapters).toEqual([
      { title: 'One', startMs: 0 },
      { title: 'Two', startMs: 99_600 },
    ]);
  });

  it('names per-file chapters after the files', () => {
    expect(perFileChapters(['/a/01 Intro.mp3', '/a/02 Part.mp3'], [1000, 2000])).toEqual([
      { title: '01 Intro', startMs: 0 },
      { title: '02 Part', startMs: 1000 },
    ]);
  });
});

describe('ffmpeg inputs', () => {
  it('escapes ffmetadata values and writes chapter ends', () => {
    const text = buildFfmetadata({ title: 'A=B; #1', authors: ['X', 'Y'] }, [{ title: 'Ch', startMs: 0 }], 5000);
    expect(text).toContain('title=A\\=B\\; \\#1');
    expect(text).toContain('artist=X, Y');
    expect(text).toContain('START=0\nEND=5000\ntitle=Ch');
  });

  it('quotes paths in the concat list', () => {
    expect(buildConcatList(["/b/it's.mp3"], [1500])).toBe("file '/b/it'\\''s.mp3'\nduration 1.500\n");
  });

  it('keeps a single file name and names a joined book after its folder', () => {
    expect(outputPathFor(['/lib/Book/01 - Book.mp3'])).toBe('/lib/Book/01 - Book.m4b');
    expect(outputPathFor(['/lib/Book/01 - Book.mp3', '/lib/Book/02 - Book.mp3'])).toBe('/lib/Book/Book.m4b');
  });

  it('writes a multi-disc book to the book folder, named after it', () => {
    expect(outputPathFor(['/lib/Book/CD1/01.mp3', '/lib/Book/CD2/01.mp3'], '/lib/Book')).toBe('/lib/Book/Book.m4b');
    expect(outputPathFor(['/lib/Book/CD1/01.mp3', '/lib/Book/CD2/01.mp3'], '/lib/Book/')).toBe('/lib/Book/Book.m4b');
    // A book folder that does not hold the files is ignored.
    expect(outputPathFor(['/lib/Other/01.mp3', '/lib/Other/02.mp3'], '/lib/Book')).toBe('/lib/Other/Other.m4b');
    // A single file stays beside itself.
    expect(outputPathFor(['/lib/Book/CD1/01.mp3'], '/lib/Book')).toBe('/lib/Book/CD1/01.m4b');
  });

  const args = (chapters: ConvertArgsInput['chapters']) =>
    buildConvertArgs({
      inputs: ['/a.mp3'],
      concatListPath: '/l',
      metadataPath: '/m',
      coverPath: null,
      outputPath: '/o.m4b',
      codec: 'copy',
      bitrate: '128k',
      channels: null,
      embedMetadata: true,
      chapters,
    });
  const mapChapters = (list: string[]) => list[list.indexOf('-map_chapters') + 1];

  it('writes no chapters at all when chapters are off, rather than copying the source ones', () => {
    expect(mapChapters(args('none'))).toBe('-1');
    expect(mapChapters(args('source'))).toBe('0');
    expect(mapChapters(args('metadata'))).toBe('1');
  });
});

describe('stored timeline', () => {
  it('is the plain running sum of whole-second lengths', () => {
    expect(plainStartsSeconds([100, 200, null, 50])).toEqual([0, 100, 300, 300]);
  });
});

describe('spreadBookmarkPositions', () => {
  it('moves a duplicate for the same user just past the first', () => {
    const out = spreadBookmarkPositions([
      { userId: 1, positionSeconds: 99.6, unique: true },
      { userId: 1, positionSeconds: 99.6, unique: true },
      { userId: 2, positionSeconds: 99.6, unique: true },
      { userId: 1, positionSeconds: 99.65, unique: true },
    ]);
    expect(out[0]).toBe(99.6);
    expect(out[2]).toBe(99.6);
    const user1 = [out[0]!, out[1]!, out[3]!].map(Math.fround);
    expect(new Set(user1).size).toBe(3);
  });

  it('leaves rows outside the unique index alone', () => {
    expect(
      spreadBookmarkPositions([
        { userId: 1, positionSeconds: 5, unique: true },
        { userId: 1, positionSeconds: 5, unique: false },
      ]),
    ).toEqual([5, 5]);
  });
});

describe('mapWithConcurrency', () => {
  it('never runs more than the limit at once and keeps the order', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      4,
      async (value) => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 2));
        running--;
        return value * 2;
      },
    );
    expect(peak).toBe(4);
    expect(out).toEqual(Array.from({ length: 20 }, (_, i) => i * 2));
  });
});

describe('AudioProbeCache', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'audio-convert-probe-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('probes at most four files at once and reuses results until a file changes', async () => {
    const paths = Array.from({ length: 12 }, (_, i) => {
      const path = join(dir, `${i}.mp3`);
      writeFileSync(path, 'x');
      return path;
    });
    let running = 0;
    let peak = 0;
    const probe = vi.fn(async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 2));
      running--;
      return { ...mp3(), chapterCount: 0 };
    });
    const cache = new AudioProbeCache(probe, 4);
    await cache.probeAll(paths);
    expect(peak).toBeLessThanOrEqual(4);
    expect(probe).toHaveBeenCalledTimes(12);

    await cache.probeAll(paths);
    expect(probe).toHaveBeenCalledTimes(12);

    writeFileSync(paths[0]!, 'changed');
    await cache.probeAll(paths);
    expect(probe).toHaveBeenCalledTimes(13);
  });
});

describe('runConvertFfmpeg stall detection', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'audio-convert-stall-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function fakeFfmpeg(name: string, body: string): string {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  }

  it('keeps a run that prints nothing but is still writing its output (the faststart pass)', async () => {
    const output = join(dir, 'growing.m4b');
    const binary = fakeFfmpeg('growing.sh', `for i in 1 2 3 4 5 6 7 8; do printf x >> '${output}'; sleep 0.1; done`);
    await expect(runConvertFfmpeg(binary, [], { outputPath: output, stallMs: 250 })).resolves.toBeUndefined();
  });

  it('kills a run whose output stopped growing', async () => {
    const output = join(dir, 'stuck.m4b');
    const binary = fakeFfmpeg('stuck.sh', `printf x > '${output}'; exec sleep 5`);
    await expect(runConvertFfmpeg(binary, [], { outputPath: output, stallMs: 200 })).rejects.toThrow('stopped making progress');
  });
});

function hasFfmpeg(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe.runIf(hasFfmpeg())('real ffmpeg', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'audio-convert-'));
    for (const [name, seconds] of [
      ['01.mp3', 3],
      ['02.mp3', 4],
      ['03.mp3', 2],
    ] as const) {
      execFileSync('ffmpeg', [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=440:duration=${seconds}`,
        '-ac',
        '2',
        '-b:a',
        '64k',
        join(dir, name),
      ]);
    }
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x64', '-frames:v', '1', join(dir, 'cover.jpg')]);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  async function convert(inputs: string[], codec: 'copy' | 'aac', output: string) {
    const probes = await Promise.all(inputs.map((path) => probeAudio('ffprobe', path)));
    const durations = probes.map((probe) => probe!.durationMs);
    const total = durations.reduce((sum, value) => sum + value, 0);
    const chapters = perFileChapters(inputs, durations);
    writeFileSync(join(dir, 'files.txt'), buildConcatList(inputs, durations));
    writeFileSync(join(dir, 'meta.txt'), buildFfmetadata({ title: 'Test Book', authors: ['Author'] }, chapters, total));
    let progress = 0;
    await runConvertFfmpeg(
      'ffmpeg',
      buildConvertArgs({
        inputs,
        concatListPath: join(dir, 'files.txt'),
        metadataPath: join(dir, 'meta.txt'),
        coverPath: join(dir, 'cover.jpg'),
        outputPath: output,
        codec,
        bitrate: '64k',
        channels: null,
        embedMetadata: true,
        chapters: 'metadata',
      }),
      { onProgress: (us) => (progress = us) },
    );
    return { total, chapters, progress, out: await probeAudio('ffprobe', output) };
  }

  it('joins three MP3s by copying, with chapters, tags and cover', async () => {
    const inputs = ['01.mp3', '02.mp3', '03.mp3'].map((name) => join(dir, name));
    const output = join(dir, 'copy.m4b');
    const { total, out, progress } = await convert(inputs, 'copy', output);
    expect(out).not.toBeNull();
    expect(Math.abs(out!.durationMs - total)).toBeLessThan(200);
    expect(out!.chapterCount).toBe(3);
    expect(out!.codec).toBe('mp3');
    expect(progress).toBeGreaterThan(0);
    const tags = execFileSync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format_tags=title,artist',
      '-show_streams',
      '-of',
      'json',
      output,
    ]).toString();
    expect(tags).toContain('Test Book');
    expect(tags).toContain('attached_pic');
  });

  it('encodes AAC', async () => {
    const { total, out } = await convert([join(dir, '01.mp3')], 'aac', join(dir, 'aac.m4b'));
    expect(out!.codec).toBe('aac');
    expect(Math.abs(out!.durationMs - total)).toBeLessThan(200);
  });

  it('can be cancelled', async () => {
    const controller = new AbortController();
    const run = runConvertFfmpeg(
      'ffmpeg',
      ['-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=600', '-c:a', 'aac', '-f', 'mp4', '-y', join(dir, 'long.m4b')],
      {
        signal: controller.signal,
      },
    );
    setTimeout(() => controller.abort(), 200);
    await expect(run).rejects.toThrow('cancelled');
  });
});

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { processAudiobook } from "@storyteller/align";

// Pieces of a split audiobook are laid end to end by every read-along client, so each piece must
// start in the source exactly where the pieces before it end, and the last must reach the end. Before
// the align patch a pause-cut dropped the pause (about 1 s per cut) and a stream-copy cut ran each
// piece past its end to the next packet (up to one frame per cut), so later sentences drifted against
// the source audiobook.

const skip =
  (spawnSync("ffmpeg", ["-version"]).status !== 0 || spawnSync("ffprobe", ["-version"]).status !== 0) && "ffmpeg or ffprobe is not installed";
const RATE = 8000;
const TOLERANCE_SECONDS = 0.002;
const LOCATE_END_SECONDS = 2.5;
const CHAPTERS = [41.37, 97.9, 160.13, 213.6];
const quiet = { info() {}, debug() {}, warn() {}, error() {} };
// A copied MP3 piece has no gapless header, so it decodes LAME's 529-sample delay as audio.
const MP3_DECODER_DELAY_SECONDS = 529 / 44100;

test("split: pieces cut at pauses line up end to end with the source", { skip }, async (t) => {
  const root = workspace(t);
  const source = makeSource(root);
  await split(root, { maxLength: 120 / 3600 });
  assertContinuous(source, join(root, "out"), 3);
});

test("split: pieces cut at chapter marks line up end to end with the source", { skip }, async (t) => {
  const root = workspace(t);
  const source = makeSource(root, { chapterMarks: CHAPTERS });
  await split(root, { maxLength: 2 });
  assertContinuous(source, join(root, "out"), 5);
});

test("split: a chapter shorter than one audio frame is dropped without breaking the chain", { skip }, async (t) => {
  const root = workspace(t);
  // Both marks sit in the same pause and round to the same packet boundary.
  const source = makeSource(root, { chapterMarks: [3.8, 3.802, ...CHAPTERS] });
  await split(root, { maxLength: 2 });
  assertContinuous(source, join(root, "out"), 6);
});

test("split: a chapter longer than the piece limit is also cut at a pause", { skip }, async (t) => {
  const root = workspace(t);
  const source = makeSource(root, { chapterMarks: [41.37] });
  await split(root, { maxLength: 120 / 3600 });
  assertContinuous(source, join(root, "out"), 3);
});

test("split: a chapter after one cut at a pause still shares its cut with the piece before", { skip }, async (t) => {
  const root = workspace(t);
  // The long chapter's last piece ends at its start plus its length, a sum that misses 132.85 in the
  // last bits; the cut must still be found as shared and snapped.
  const source = makeSource(root, { chapterMarks: [3.871, 132.85], seconds: 300 });
  await split(root, { maxLength: 120 / 3600 });
  assertContinuous(source, join(root, "out"), 5);
});

test("split: a chapter mark inside the last packet moves to that packet's start", { skip }, async (t) => {
  const root = workspace(t);
  // The file ends 10 ms into its last AAC packet, in a pause, and the mark sits 5 ms before the end.
  const source = makeSource(root, { chapterMarks: [...CHAPTERS, 249.295], seconds: 249.3 });
  await split(root, { maxLength: 2 });
  assertContinuous(source, join(root, "out"), 6);
});

test("split: audio that starts after zero lines up end to end with the source", { skip }, async (t) => {
  const root = workspace(t);
  const source = makeSource(root, { chapterMarks: CHAPTERS, startOffset: 1.97678 });
  await split(root, { maxLength: 2 });
  // STAlign ends the last piece at the duration its metadata reports, which on such a file falls one
  // frame short of the decoded end; that predates the patch and moves no earlier piece.
  assertContinuous(source, join(root, "out"), 5, { checkEnd: false });
});

test("split: a copied MP3 lines up end to end with the source", { skip }, async (t) => {
  const root = workspace(t);
  const source = makeSource(root, { chapterMarks: CHAPTERS, format: "cbr-mp3" });
  await split(root, { maxLength: 2 });
  assertContinuous(source, join(root, "out"), 5, { decoderDelay: MP3_DECODER_DELAY_SECONDS });
});

test("split: a PCM WAV is cut on the exact sample", { skip }, async (t) => {
  const root = workspace(t);
  const source = makeSource(root, { format: "wav" });
  await split(root, { maxLength: 120 / 3600 });
  assertContinuous(source, join(root, "out"), 3);
  assertSameSamples(source, join(root, "out"));
});

test("split: a FLAC is cut on the exact sample and each piece reports its own length", { skip }, async (t) => {
  const root = workspace(t);
  const source = makeSource(root, { format: "flac" });
  await split(root, { maxLength: 120 / 3600 });
  assertContinuous(source, join(root, "out"), 3);
  assertSameSamples(source, join(root, "out"));
});

test("split: each audio stream keeps its own lossless codec", { skip }, async (t) => {
  const root = workspace(t);
  const source = join(root, "source", "book.mp4");
  const tone = (frequency) => ["-f", "lavfi", "-i", `sine=f=${frequency}:d=20:r=44100`];
  execFileSync("ffmpeg", ["-v", "error", ...tone(440), ...tone(660), "-map", "0", "-map", "1", "-c:a:0", "pcm_s16le", "-c:a:1", "pcm_s24le", source]);
  await split(root, { maxLength: 2 });
  const [piece] = readdirSync(join(root, "out")).filter((name) => !name.endsWith(".json"));
  assert.deepEqual(codecs(join(root, "out", piece)), codecs(source));
});

test("split: cuts around a gap between chapters never run a piece backwards", { skip }, async (t) => {
  const root = workspace(t);
  // Both cuts after the gap snap to the same packet start, before the second chapter begins.
  const source = makeSource(root, {
    format: "cbr-mp3",
    seconds: 3,
    chapters: [
      [0, 0.994],
      [0.998, 0.999],
      [0.999, 1],
      [1, 3],
    ],
  });
  await split(root, { maxLength: 2 });
  const sidecars = readdirSync(join(root, "out")).filter((name) => name.endsWith(".source.json"));
  assert.ok(sidecars.length > 0, `${source} was split`);
  for (const name of sidecars) {
    const { start, end } = JSON.parse(readFileSync(join(root, "out", name), "utf8"));
    assert.ok(start <= end, `${name} runs from ${start} to ${end}`);
  }
});

// Regression guard, not coverage of the patch: STAlign re-encodes a variable bitrate MP3 to constant
// bitrate, which cuts on the exact sample without any of the patch's snapping.
test("split: a variable bitrate MP3 re-encoded to constant bitrate still lines up (regression guard)", { skip }, async (t) => {
  const root = workspace(t);
  const source = makeSource(root, { chapterMarks: CHAPTERS, format: "vbr-mp3" });
  await split(root, { maxLength: 2 });
  assertContinuous(source, join(root, "out"), 5);
});

test("split: an audiobook in several files lines up end to end with the files in order", { skip }, async (t) => {
  const root = workspace(t);
  // The files look for chapter-cut silences at the same time, which once let their VAD scratch files collide.
  const marks = [[...CHAPTERS], [61.2, 150.45], [20.4, 88.8, 201.3], [130.2]];
  const files = marks.map((chapterMarks, i) => makeSource(root, { chapterMarks, name: `part${i + 1}`, seed: 7 + i }));
  await split(root, { maxLength: 2 });
  assertContinuous(files, join(root, "out"), 14);
});

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), "read-aloud-split-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "source"));
  return root;
}

function split(root, options) {
  return processAudiobook(join(root, "source"), join(root, "out"), { parallelism: 1, logger: quiet, ...options });
}

const CODECS = {
  m4b: ["-c:a", "aac", "-b:a", "64k"],
  "cbr-mp3": ["-c:a", "libmp3lame", "-b:a", "64k"],
  "vbr-mp3": ["-c:a", "libmp3lame", "-q:a", "4"],
  wav: ["-c:a", "pcm_s16le"],
  flac: ["-c:a", "flac"],
};

/** Seeded noise in 3.3 s bursts with 1 s gaps, which the VAD hears as sentences and pauses. */
function makeSource(root, { chapterMarks = [], chapters, startOffset = 0, format = "m4b", name = "book", seed = 7, seconds = 250 } = {}) {
  const path = join(root, "source", `${name}.${{ m4b: "m4b", wav: "wav", flac: "flac" }[format] ?? "mp3"}`);
  // Loudness swinging several times a second makes LAME's VBR mode vary its frame sizes.
  const swing = format === "vbr-mp3" ? ",volume='0.01+0.99*abs(sin(t*9))':eval=frame" : "";
  const args = [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `anoisesrc=d=${seconds}:c=pink:seed=${seed}:a=0.3:r=44100,volume='if(lt(mod(t,4.3),3.3),1,0)':eval=frame${swing}`,
  ];
  const bounds = [0, ...chapterMarks, seconds];
  const spans = chapters ?? (chapterMarks.length ? bounds.slice(1).map((end, i) => [bounds[i], end]) : []);
  if (spans.length) {
    const ms = (value) => Math.round(value * 1000);
    const entries = spans.map(([start, end], i) => `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${ms(start)}\nEND=${ms(end)}\ntitle=Chapter ${i + 1}\n`);
    writeFileSync(join(root, `${name}.chapters.txt`), `;FFMETADATA1\n${entries.join("")}`);
    args.push("-i", join(root, `${name}.chapters.txt`), "-map", "0:a", "-map_metadata", "1");
  }
  if (startOffset) args.push("-output_ts_offset", String(startOffset));
  execFileSync("ffmpeg", [...args, "-ac", "1", ...CODECS[format], path]);
  return path;
}

/**
 * `sourcePaths` is one file, or the files of one audiobook in order, which are laid end to end too.
 * `decoderDelay` is how much later than its recorded start a piece that does not open its file decodes.
 */
function assertContinuous(sourcePaths, outDir, expectedPieces, { decoderDelay = 0, checkEnd = true } = {}) {
  const files = [sourcePaths].flat();
  const source = concat(files.map(decode));
  const fileStarts = [];
  let total = 0;
  for (const file of files) {
    fileStarts.push(total);
    total += duration(file);
  }
  const pieces = readdirSync(outDir)
    .filter((name) => !name.endsWith(".json"))
    .sort();
  assert.equal(pieces.length, expectedPieces);
  let laidEndToEnd = 0;
  let previousEnd = null;
  let previousFile = -1;
  for (const name of pieces) {
    const path = join(outDir, name);
    const recorded = JSON.parse(readFileSync(path.replace(/\.\w+$/, ".source.json"), "utf8"));
    const fileIndex = files.findIndex((file) => basename(file) === basename(recorded.source));
    assert.notEqual(fileIndex, -1, `${name} records its source ${recorded.source}`);
    const fileStart = fileStarts[fileIndex];
    if (fileIndex !== previousFile) assert.equal(recorded.start, 0, `${name} starts its file at 0`);
    else assert.equal(recorded.start, previousEnd, `${name} starts where the piece before it ends`);
    previousFile = fileIndex;
    previousEnd = recorded.end;
    const pieceSeconds = duration(path);
    // A piece too short to correlate is still covered by the chain and by the total length below.
    if (pieceSeconds >= LOCATE_END_SECONDS) {
      const found = locate(source, decode(path), laidEndToEnd);
      assert.ok(
        Math.abs(found - laidEndToEnd) < TOLERANCE_SECONDS,
        `${name} is at ${found.toFixed(4)} s in the source, laid end to end at ${laidEndToEnd.toFixed(4)} s`,
      );
      const delay = recorded.start === 0 ? 0 : decoderDelay;
      assert.ok(
        Math.abs(found - fileStart - recorded.start - delay) < TOLERANCE_SECONDS,
        `${name} records its start ${recorded.start} as ${(found - fileStart - delay).toFixed(4)} s`,
      );
    }
    laidEndToEnd += pieceSeconds;
  }
  if (!checkEnd) return;
  assert.ok(Math.abs(laidEndToEnd - total) < TOLERANCE_SECONDS, `the pieces add up to ${laidEndToEnd.toFixed(4)} s of ${total.toFixed(4)} s`);
  assert.ok(
    Math.abs(fileStarts.at(-1) + previousEnd - total) < TOLERANCE_SECONDS,
    `the last piece records its end ${previousEnd} of ${total.toFixed(4)} s`,
  );
}

/** The pieces' samples, at the source's own rate and format, are the source's samples. */
function assertSameSamples(sourcePath, outDir) {
  const pieces = readdirSync(outDir)
    .filter((name) => !name.endsWith(".json"))
    .sort();
  const joined = Buffer.concat(pieces.map((name) => samples(join(outDir, name))));
  const original = samples(sourcePath);
  assert.equal(joined.length, original.length, `the pieces hold ${joined.length} sample bytes of ${original.length}`);
  assert.ok(joined.equals(original), "the pieces' samples differ from the source's");
}

function samples(path) {
  return execFileSync("ffmpeg", ["-v", "error", "-i", path, "-f", "s16le", "-"], { maxBuffer: 64 * 1024 * 1024 });
}

function codecs(path) {
  return execFileSync("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_name", "-of", "csv=p=0", path], {
    encoding: "utf8",
  })
    .trim()
    .split("\n");
}

function concat(arrays) {
  const out = new Float32Array(arrays.reduce((sum, array) => sum + array.length, 0));
  let at = 0;
  for (const array of arrays) {
    out.set(array, at);
    at += array.length;
  }
  return out;
}

function decode(path) {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", path, "-ac", "1", "-ar", String(RATE), "-f", "f32le", "-"], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
}

function duration(path) {
  return Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], { encoding: "utf8" }));
}

/** Where the piece's audio sits in the source, searching one second either side of `expected`. */
function locate(source, piece, expected) {
  const window = piece.subarray(Math.round(0.5 * RATE), Math.round(LOCATE_END_SECONDS * RATE));
  const offset = Math.round(0.5 * RATE);
  let best = { score: -Infinity, lag: 0 };
  const from = Math.max(0, Math.round((expected - 1) * RATE) + offset);
  const to = Math.min(source.length - window.length, Math.round((expected + 1) * RATE) + offset);
  for (let lag = from; lag <= to; lag++) {
    let dot = 0;
    let energy = 0;
    for (let i = 0; i < window.length; i++) {
      const sample = source[lag + i];
      dot += sample * window[i];
      energy += sample * sample;
    }
    const score = dot / Math.sqrt(energy || 1);
    if (score > best.score) best = { score, lag };
  }
  return (best.lag - offset) / RATE;
}

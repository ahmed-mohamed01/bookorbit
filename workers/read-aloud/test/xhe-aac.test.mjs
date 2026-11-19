import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stageInputs } from "../dist/stages.js";
import { AUDIO_PREPARE_VERSION, XHE_AAC_STALL_MS, assertFullyDecoded, decodedShare, reencodeArgs, reencodeXheAac } from "../dist/xhe-aac.js";

const track = (name, duration, start, end) => ({ name, duration, source: { file: "0001.m4b", start, end, title: null } });

test("xhe-aac: audio that decoded 24% short is caught", () => {
  // Chapters 73 and 74 of an xHE-AAC audiobook through ffmpeg's native decoder.
  const decoded = decodedShare([track("1", 12.5, 0, 15.805986), track("2", 787.1, 15.805986, 1056.304227), track("3", 793.6, 1056.304227, 2105.249754)]);
  assert.equal(decoded.tracks, 2, "the 16 s credits piece is too short to judge");
  assert.equal(Math.round(decoded.share * 100), 76);
});

test("xhe-aac: frame rounding and packet-aligned cuts are not a short decode", () => {
  assert.ok(decodedShare([track("a", 1169.04, 12.932993, 1182.056984), track("b", 1106.4, 1182.056984, 1288.6)]).share > 0.98);
});

test("xhe-aac: one piece cut short by a chapter mark past the end of its file does not decide it", () => {
  const tracks = [track("1", 1040.4, 15.8, 1056.3), track("2", 1048.8, 1056.3, 2105.2), track("3", 776.4, 6423.8, 7448.6), track("4", 0, 7448.6, 8790.5)];
  assert.doesNotThrow(() => assertFullyDecoded(tracks));
});

test("xhe-aac: tracks without a source or duration are skipped", () => {
  assert.equal(decodedShare([{ name: "a.mp3", duration: 10, source: null }, { name: "b.mp3" }]), null);
  assert.equal(decodedShare(undefined), null);
  assert.doesNotThrow(() => assertFullyDecoded(undefined));
});

test("xhe-aac: a short decode fails the job as invalid output", () => {
  assert.throws(() => assertFullyDecoded([track("x", 750, 0, 1000), track("y", 760, 1000, 2000)]), (error) => error.code === "invalid_output" && /decoded to 76% of its length/.test(error.message));
  assert.doesNotThrow(() => assertFullyDecoded([track("x", 999.5, 0, 1000)]));
});

test("xhe-aac: frames that cannot be decoded become silence, and chapters are kept", () => {
  const args = reencodeArgs("in.m4b", "out.m4b", "native");
  assert.ok(args.includes("aresample=async=1:first_pts=0,aformat=sample_fmts=s16"), "out-of-range samples are clipped before the encoder");
  assert.deepEqual(args.slice(args.indexOf("-progress"), args.indexOf("-progress") + 2), ["-progress", "pipe:1"]);
  assert.deepEqual(args.slice(args.indexOf("-map_chapters"), args.indexOf("-map_chapters") + 2), ["-map_chapters", "0"]);
  assert.ok(args.indexOf("in.m4b") > 0 && !args.includes("libfdk_aac"));
});

test("xhe-aac: libfdk_aac decodes the input when ffmpeg has it", () => {
  const args = reencodeArgs("in.m4b", "out.m4b", "libfdk_aac");
  assert.ok(args.indexOf("libfdk_aac") < args.indexOf("-i"));
});

test("xhe-aac: audio split before the re-encode existed is split again", () => {
  const source = {
    epub: { path: "/b/book.epub", size: 1, mtimeMs: 1 },
    audio: [{ path: "/b/01.m4b", size: 2, mtimeMs: 2 }],
    language: "en",
    granularity: "sentence",
    model: "quartznet15x5",
    decisions: { chapters: {}, audio: [] },
  };
  assert.equal(stageInputs("preparing_audio", source).prepare, AUDIO_PREPARE_VERSION);
});

test("xhe-aac: only the xHE-AAC link is replaced, and the library file is never written", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "read-aloud-xhe-")));
  try {
    const library = join(root, "library");
    const work = join(root, "source-audio");
    const bin = join(root, "bin");
    for (const dir of [library, work, bin]) mkdirSync(dir);
    writeFileSync(join(library, "new.m4b"), "xhe-bytes");
    writeFileSync(join(library, "old.m4b"), "lc-bytes");
    symlinkSync(join(library, "new.m4b"), join(work, "0001.m4b"));
    symlinkSync(join(library, "old.m4b"), join(work, "0002.m4b"));
    // Stand-ins: ffprobe reads the profile from the file's bytes, ffmpeg writes its last argument.
    writeFileSync(join(bin, "ffprobe"), `#!/bin/sh\nfor a; do f="$a"; done\ngrep -q xhe "$f" && echo xHE-AAC || echo LC\n`);
    writeFileSync(join(bin, "ffmpeg"), `#!/bin/sh\ncase "$*" in *-decoders*) echo " A....D aac  AAC"; exit 0;; esac\nfor a; do f="$a"; done\necho "$*" > "$f"\n`);
    chmodSync(join(bin, "ffprobe"), 0o755);
    chmodSync(join(bin, "ffmpeg"), 0o755);
    const events = [];
    const context = { signal: new AbortController().signal, event: (...args) => events.push(args) };
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    let count;
    try {
      count = await reencodeXheAac(work, context);
    } finally {
      process.env.PATH = path;
    }
    assert.equal(count, 1);
    assert.ok(lstatSync(join(work, "0001.m4b")).isFile(), "the xHE-AAC link is now a file of its own");
    assert.match(readFileSync(join(work, "0001.m4b"), "utf8"), /aresample=async=1/);
    assert.ok(lstatSync(join(work, "0002.m4b")).isSymbolicLink(), "other audio is left linked");
    assert.equal(readFileSync(join(library, "new.m4b"), "utf8"), "xhe-bytes");
    assert.deepEqual(readdirSync(work).sort(), ["0001.m4b", "0002.m4b"]);
    assert.deepEqual(
      events.map(([level, code, , data]) => [level, code, data.file, data.decoder]),
      [["warn", "audio_xhe_aac_reencoded", "0001.m4b", "native"]],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A source audio folder whose one file is linked from a library folder, with stand-in tools on PATH. */
function workspace(t, { ffprobe, ffmpeg }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "read-aloud-xhe-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const library = join(root, "library");
  const work = join(root, "source-audio");
  const bin = join(root, "bin");
  for (const dir of [library, work, bin]) mkdirSync(dir);
  writeFileSync(join(bin, "ffprobe"), ffprobe);
  chmodSync(join(bin, "ffprobe"), 0o755);
  if (ffmpeg) {
    writeFileSync(join(bin, "ffmpeg"), ffmpeg);
    chmodSync(join(bin, "ffmpeg"), 0o755);
  }
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  t.after(() => {
    process.env.PATH = path;
  });
  const events = [];
  const context = { signal: new AbortController().signal, event: (...args) => events.push(args) };
  return { library, work, context, events };
}

const XHE_PROBE = '#!/bin/sh\necho xHE-AAC\n';

test("xhe-aac: a re-encode that stops advancing fails the job and leaves the link", async (t) => {
  const { library, work, context } = workspace(t, {
    ffprobe: XHE_PROBE,
    ffmpeg: '#!/bin/sh\ncase "$*" in *-decoders*) exit 0;; esac\necho out_time_us=1000000\nexec sleep 30\n',
  });
  writeFileSync(join(library, "book.m4b"), "xhe-bytes");
  symlinkSync(join(library, "book.m4b"), join(work, "0001.m4b"));
  await assert.rejects(reencodeXheAac(work, context, 300), (error) => error.code === "audio_processing_failed" && /stopped advancing/.test(error.message));
  assert.ok(lstatSync(join(work, "0001.m4b")).isSymbolicLink());
  assert.deepEqual(readdirSync(work), ["0001.m4b"]);
  assert.ok(XHE_AAC_STALL_MS >= 60_000, "a slow machine is not taken for a stuck encode");
});

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** Mono 32-bit float WAV: a quiet tone with three frames of samples ~1e10 times full scale. */
function spikeWav() {
  const rate = 44100;
  const samples = rate * 3;
  const data = Buffer.alloc(samples * 4);
  for (let i = 0; i < samples; i++) {
    const spike = i >= rate && i < rate + 3 * 1024;
    data.writeFloatLE(spike ? 9.6e9 * Math.sin(i) : 0.3 * Math.sin((2 * Math.PI * 220 * i) / rate), i * 4);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(3, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(32, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

test("xhe-aac: decoder garbage billions of times full scale is clipped so the AAC encoder takes it", { skip: !hasFfmpeg && "ffmpeg is not installed" }, async (t) => {
  const { library, work, context } = workspace(t, { ffprobe: XHE_PROBE });
  writeFileSync(join(library, "book.m4b"), spikeWav());
  symlinkSync(join(library, "book.m4b"), join(work, "0001.m4b"));
  // Without the 16-bit step ffmpeg's AAC encoder rejects this file outright. On the real book's frames it
  // passes that check and then spins forever, which only a full decode from the start reproduces.
  assert.equal(await reencodeXheAac(work, context, 20_000), 1);
  assert.ok(lstatSync(join(work, "0001.m4b")).isFile());
  assert.ok(existsSync(join(work, "0001.m4b")));
});

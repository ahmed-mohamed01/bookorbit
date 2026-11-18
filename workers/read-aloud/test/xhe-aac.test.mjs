import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stageInputs } from "../dist/stages.js";
import { AUDIO_PREPARE_VERSION, assertFullyDecoded, decodedShare, reencodeArgs, reencodeXheAac } from "../dist/xhe-aac.js";

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
  assert.ok(args.includes("aresample=async=1:first_pts=0"));
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

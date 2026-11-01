import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stat, writeFile } from "node:fs/promises";
import { crc32 } from "node:zlib";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { test } from "node:test";
import { validateRequest } from "../dist/validation.js";
import { FAKE_PIPELINE, jobRequest, makeSandbox, stagesRun } from "./helpers.mjs";

const alignRequire = createRequire(import.meta.resolve("@storyteller-platform/align"));
const epubRequire = createRequire(alignRequire.resolve("@storyteller-platform/epub"));
const { ZipFile } = alignRequire("yazl");
const yauzl = epubRequire("yauzl-promise");
const sha256 = createHash("sha256").update("audio").digest("hex");
const totals = {
  sentences: 10,
  matchedSentences: 9,
  interpolatedSentences: 1,
  unmatchedSentences: 0,
  droppedSentences: 0,
  seconds: 60,
  matchedSeconds: 58,
  interpolatedSeconds: 1,
  looseSeconds: 1,
  tracks: 2,
  unalignedTracks: 0,
};
const content = {
  mimetype: "application/epub+zip",
  "OPS/book.opf": '<package><manifest><item href="a.mp3" media-type="audio/mpeg"/><item href="b.mp3" media-type="audio/mpeg"/></manifest></package>',
  "OPS/cover.png": "image",
  "OPS/chapter.xhtml": '<p id="s1">Text</p>',
  "OPS/chapter.smil": "<smil/>",
};
const rebuild = {
  indexEntry: "index.epub",
  reportEntry: "bookorbit-timings/report.json",
  chunks: [1, 2].map((n) => ({ name: `0000${n}-00001.mp3`, size: 5, sha256 })),
  audioEntries: [1, 2].map((n) => ({ href: `OPS/${n === 1 ? "a" : "b"}.mp3`, chunk: `0000${n}-00001.mp3` })),
};

async function zip(path, entries) {
  const archive = new ZipFile();
  const done = pipeline(archive.outputStream, createWriteStream(path));
  for (const [name, text] of Object.entries(entries)) archive.addBuffer(Buffer.from(text), name, { compress: false });
  archive.end();
  await done;
}
async function crcs(path) {
  const archive = await yauzl.open(path);
  try {
    const result = {};
    for await (const entry of archive) result[entry.filename] = entry.crc32;
    return result;
  } finally {
    await archive.close();
  }
}

test("rebuild preserves every original entry CRC and skips the model/emissions/markup", async () => {
  const sandbox = makeSandbox();

  try {
    await zip(join(sandbox.book, "book.epub"), { ...content, "OPS/a.mp3": "audio", "OPS/b.mp3": "audio" });
    const normal = jobRequest(sandbox);
    assert.equal((await run(sandbox, normal, "fixture")).status, "completed");
    const request = jobRequest(sandbox, { rebuild });
    await mkdir(request.workDir, { recursive: true });
    await zip(join(request.workDir, "index.epub"), { ...content, "bookorbit-timings/report.json": JSON.stringify({ version: 4, totals }) });
    const result = await run(sandbox, request);
    assert.equal(result.status, "completed", result.error);
    assert(result.events.some((event) => event.code === "rebuild_from_index"));
    assert.match(result.stdout, /\[read_aloud\.worker\.run\] \[end\] jobId=\S+ durationMs=\d+ outputBytes=\d+ rebuild=true - run finished/);
    assert.deepEqual(
      stagesRun(sandbox, request.jobId).map((entry) => entry.stage),
      ["preparing_audio"],
    );
    assert.deepEqual(await crcs(join(request.workDir, "output.epub")), await crcs(join(normal.workDir, "output.epub")));
  } finally {
    sandbox.cleanup();
  }
});

for (const mode of ["restored", "different", "missing"])
  test(`source entries are ${mode}`, async () => {
    const sandbox = makeSandbox();
    try {
      const full = { ...content, "OPS/a.mp3": "audio", "OPS/b.mp3": "audio" };
      await zip(join(sandbox.book, "book.epub"), full);
      const normal = jobRequest(sandbox);
      assert.equal((await run(sandbox, normal, "fixture")).status, "completed");
      if (mode !== "restored") {
        const source = { ...content };
        if (mode === "missing") delete source["OPS/cover.png"];
        else source["OPS/cover.png"] = "other";
        await zip(join(sandbox.book, "book.epub"), source);
      }
      const request = jobRequest(sandbox, {
        rebuild: { ...rebuild, sourceEntries: [{ href: "OPS/cover.png", size: 5, crc32: crc32(Buffer.from("image")), position: 2 }] },
      });
      await mkdir(request.workDir, { recursive: true });
      const index = { ...content, "bookorbit-timings/report.json": JSON.stringify({ version: 4, totals }) };
      delete index["OPS/cover.png"];
      await zip(join(request.workDir, "index.epub"), index);
      const result = await run(sandbox, request);
      assert.equal(result.status, "completed", result.error);
      assert(result.events.some((event) => event.code === (mode === "restored" ? "rebuild_from_index" : "rebuild_mismatch_fallback")));
      if (mode === "restored") {
        const [rebuilt, original] = await Promise.all([crcs(join(request.workDir, "output.epub")), crcs(join(normal.workDir, "output.epub"))]);
        assert.deepEqual(rebuilt, original);
        assert.deepEqual(Object.keys(rebuilt), Object.keys(original));
      }
    } finally {
      sandbox.cleanup();
    }
  });

test("restored entries at the same position follow capture order", async () => {
  const sandbox = makeSandbox();
  try {
    const full = { ...content, "OPS/a.mp3": "audio", "OPS/b.mp3": "audio" };
    delete full["OPS/cover.png"];
    const aligned = Object.fromEntries(
      Object.entries(full).flatMap(([name, value]) =>
        name === "OPS/chapter.xhtml"
          ? [
              ["OPS/cover.png", "image"],
              ["OPS/font.ttf", "font"],
              [name, value],
            ]
          : [[name, value]],
      ),
    );
    await zip(join(sandbox.book, "book.epub"), aligned);
    const normal = jobRequest(sandbox);
    assert.equal((await run(sandbox, normal, "fixture")).status, "completed");
    const source = { ...aligned };
    delete source["OPS/cover.png"];
    delete source["OPS/font.ttf"];
    await zip(join(sandbox.book, "book.epub"), { ...source, "OPS/font.ttf": "font", "OPS/cover.png": "image" });
    const sourceEntries = [
      ["OPS/cover.png", "image"],
      ["OPS/font.ttf", "font"],
    ].map(([href, value]) => ({ href, size: Buffer.byteLength(value), crc32: crc32(Buffer.from(value)), position: 2 }));
    const request = jobRequest(sandbox, { rebuild: { ...rebuild, sourceEntries } });
    await mkdir(request.workDir, { recursive: true });
    const index = { ...source, "bookorbit-timings/report.json": JSON.stringify({ version: 4, totals }) };
    delete index["OPS/a.mp3"];
    delete index["OPS/b.mp3"];
    await zip(join(request.workDir, "index.epub"), index);
    const result = await run(sandbox, request);
    assert.equal(result.status, "completed", result.error);
    assert(result.events.some((event) => event.code === "rebuild_from_index"));
    const [rebuilt, original] = await Promise.all([crcs(join(request.workDir, "output.epub")), crcs(join(normal.workDir, "output.epub"))]);
    assert.deepEqual(rebuilt, original);
    assert.deepEqual(Object.keys(rebuilt), Object.keys(original));
  } finally {
    sandbox.cleanup();
  }
});

test("a mismatched chunk falls back to full alignment in the same run", async () => {
  const sandbox = makeSandbox();

  try {
    const request = jobRequest(sandbox, { rebuild: { ...rebuild, chunks: rebuild.chunks.map((chunk) => ({ ...chunk, sha256: "0".repeat(64) })) } });
    const result = await run(sandbox, request);
    assert.equal(result.status, "completed", result.error);
    assert(result.events.some((event) => event.code === "rebuild_mismatch_fallback"));
    assert.deepEqual(
      stagesRun(sandbox, request.jobId).map((entry) => entry.stage),
      ["preparing_audio", "generating_emissions", "marking_up_ebook", "aligning"],
    );
  } finally {
    sandbox.cleanup();
  }
});

test("an extra prepared chunk falls back to full alignment", async () => {
  const sandbox = makeSandbox();
  try {
    const request = jobRequest(sandbox, { rebuild });
    await mkdir(join(request.workDir, "processed-audio"), { recursive: true });
    await writeFile(join(request.workDir, "processed-audio", "extra.mp3"), "extra");
    const result = await run(sandbox, request);
    assert.equal(result.status, "completed", result.error);
    assert(result.events.some((event) => event.code === "rebuild_mismatch_fallback"));
    assert.deepEqual(
      stagesRun(sandbox, request.jobId).map((entry) => entry.stage),
      ["preparing_audio", "generating_emissions", "marking_up_ebook", "aligning"],
    );
  } finally {
    sandbox.cleanup();
  }
});

test("rebuild validation bounds paths, hashes, counts and references", () => {
  const sandbox = makeSandbox();
  try {
    const request = jobRequest(sandbox);
    assert.equal(validateRequest(request).rebuild, null);
    assert.deepEqual(validateRequest({ ...request, rebuild }).rebuild, rebuild);
    const source = { href: "OPS/image.png", size: 5, crc32: 0xffffffff };
    assert.deepEqual(validateRequest({ ...request, rebuild: { ...rebuild, sourceEntries: [source] } }).rebuild.sourceEntries, [source]);
    for (const sourceEntries of [
      ...["../image.png", "mimetype", "bookorbit-timings/image.png", "OPS/a.mp3", "OPS/./image.png"].map((href) => [{ ...source, href }]),
      [source, source],
      [{ ...source, size: -1 }],
      [{ ...source, size: 1.5 }],
      [{ ...source, crc32: -1 }],
      [{ ...source, crc32: 0x100000000 }],
      [{ ...source, crc32: 1.5 }],
      [{ ...source, position: -1 }],
      [{ ...source, position: 1.5 }],
      Array(10001).fill(source),
    ])
      assert.throws(() => validateRequest({ ...request, rebuild: { ...rebuild, sourceEntries } }));
    for (const bad of [
      { ...rebuild, indexEntry: "../index.epub" },
      { ...rebuild, reportEntry: "/secret" },
      { ...rebuild, chunks: Array(10001).fill(rebuild.chunks[0]) },
      { ...rebuild, chunks: [{ ...rebuild.chunks[0], name: "../a.mp3" }] },
      { ...rebuild, audioEntries: [{ href: "OPS/a.mp3", chunk: "missing" }] },
      { ...rebuild, chunks: [{ ...rebuild.chunks[0], sha256: "bad" }] },
    ])
      assert.throws(() => validateRequest({ ...request, rebuild: bad }));
  } finally {
    sandbox.cleanup();
  }
});

async function run(sandbox, request, mode = "ok") {
  const fingerprint = async (path) => {
    const info = await stat(path);
    return { path, size: info.size, mtimeMs: info.mtimeMs };
  };
  const job = {
    ...request,
    attempt: 1,
    epub: await fingerprint(request.epubPath),
    audio: await Promise.all(request.audioPaths.map(fingerprint)),
    rebuild: request.rebuild ?? null,
    device: "cpu",
    dtype: null,
    batchSize: null,
    redactions: [],
  };
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(new URL("../dist/runner.js", import.meta.url)), [], {
      stdio: ["ignore", "pipe", "ignore", "ipc"],
      env: { ...process.env, READ_ALOUD_RUNNER_PIPELINE: FAKE_PIPELINE, FAKE_PIPELINE_MODE: mode, FAKE_PIPELINE_LOG: sandbox.logPath },
    });
    const events = [];
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Runner timed out"));
    }, 10000);
    let result;
    child.on("message", (message) => {
      if (message.type === "event") events.push(message);
      if (message.type === "done") result = { status: "completed", events };
      if (message.type === "failed") result = { status: "failed", error: message.message, events };
    });
    child.on("error", reject);
    child.on("close", () => {
      clearTimeout(timeout);
      if (result) resolve({ ...result, stdout });
      else reject(new Error("Runner exited without a result"));
    });
    child.send({ type: "start", job });
  });
}

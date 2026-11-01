import assert from "node:assert/strict";
import { execFileSync, fork, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { crc32 } from "node:zlib";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { test } from "node:test";
import { chapterAligned, classifySpine, markup, upgradeEpub } from "@storyteller-platform/align";
import { validateRequest } from "../dist/validation.js";
import { FAKE_PIPELINE, jobRequest, makeSandbox, stagesRun } from "./helpers.mjs";

const alignRequire = createRequire(import.meta.resolve("@storyteller-platform/align"));
const epubRequire = createRequire(alignRequire.resolve("@storyteller-platform/epub"));
const { Epub } = await import(pathToFileURL(alignRequire.resolve("@storyteller-platform/epub")).href);
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

test("a missing timing index reports its reason and falls back to full alignment", async () => {
  const sandbox = makeSandbox();
  try {
    const request = jobRequest(sandbox, { rebuild });
    const result = await run(sandbox, request);
    assert.equal(result.status, "completed", result.error);
    const fallback = result.events.find((event) => event.code === "rebuild_mismatch_fallback");
    assert.equal(fallback.message, "Timing index cannot be reused; running full alignment");
    assert.equal(fallback.data.reason, "The timing index is missing");
    assert.match(result.stdout, /reason="The timing index is missing" - Timing index cannot be reused; running full alignment/);
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

async function replayFixture(sandbox, version = "3.0", { pageBody, guide = true } = {}) {
  const { sourceChapterFingerprint } = await import("../dist/rebuild-metadata.js");
  const request = jobRequest(sandbox);
  await mkdir(join(request.workDir, "processed-audio"), { recursive: true });
  const container =
    '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';
  const opf = (title, aligned = false) =>
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">book</dc:identifier><dc:title>${title}</dc:title><dc:language>en</dc:language>${aligned ? '<meta property="media:duration" refines="#c_overlay">0:01:00</meta><meta property="media:duration">0:01:00</meta><meta property="media:active-class">-epub-media-overlay-active</meta>' : ""}</metadata><manifest><item id="c" href="chapter.xhtml" media-type="application/xhtml+xml"${aligned ? ' media-overlay="c_overlay"' : ""}/><item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/><item id="coverpage" href="cover.xhtml" media-type="application/xhtml+xml"/><item id="style" href="style.css" media-type="text/css"/><item id="font" href="font.woff2" media-type="font/woff2"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>${aligned ? '<item id="c_overlay" href="MediaOverlays/chapter.smil" media-type="application/smil+xml"/><item id="randomAudio" href="Audio/00001.mp3" media-type="audio/mpeg"/><item id="storyteller_readaloud_styles" href="Styles/storyteller-readaloud.css" media-type="text/css"/>' : ""}</manifest><spine toc="ncx"><itemref idref="coverpage"/><itemref idref="c"/></spine></package>`;
  const packageWithPage = (title, aligned = false) => {
    let text = opf(title, aligned);
    if (pageBody !== undefined) {
      text = text
        .replace("</manifest>", '<item id="page" href="page.xhtml" media-type="application/xhtml+xml"/></manifest>')
        .replace('<itemref idref="c"/>', '<itemref idref="page"/><itemref idref="c"/>');
      if (guide) text = text.replace("</package>", '<guide><reference type="cover" title="Cover" href="page.xhtml"/></guide></package>');
    }
    return text;
  };
  const source = {
    mimetype: "application/epub+zip",
    "META-INF/container.xml": container,
    "OPS/book.opf": packageWithPage("NEW TITLE").replace('version="3.0"', `version="${version}"`),
    "OPS/chapter.xhtml": '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter</title></head><body><p>Hello world</p></body></html>',
    "OPS/toc.ncx":
      '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head/><docTitle><text>Current book</text></docTitle><navMap><navPoint id="chapter" playOrder="1"><navLabel><text>Chapter</text></navLabel><content src="chapter.xhtml"/></navPoint></navMap></ncx>',
    "OPS/cover.xhtml":
      '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Cover</title></head><body><img src="cover.png" alt="NEW COVER"/></body></html>',
    "OPS/cover.png": "NEW COVER",
    "OPS/style.css": "NEW CSS",
    "OPS/font.woff2": "FONT",
  };
  if (pageBody !== undefined)
    source["OPS/page.xhtml"] = `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Page</title></head><body>${pageBody}</body></html>`;
  const sourcePath = join(sandbox.book, "book.epub");
  await zip(sourcePath, source);
  const archive = await yauzl.open(sourcePath);
  const sourceEntries = [];
  for await (const entry of archive) sourceEntries.push(entry);
  const fingerprint = await sourceChapterFingerprint(sourceEntries);
  await archive.close();
  const alignedChapter =
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><link rel="stylesheet" href="Styles/storyteller-readaloud.css" type="text/css"/></head><body><p><span id="c-s0" epub:type="storyteller:sentence-span">Hello world</span></p></body></html>';
  const smil =
    '<smil xmlns="http://www.w3.org/ns/SMIL" xmlns:epub="http://www.idpf.org/2007/ops" version="3.0" epub:prefix="storyteller: https://storyteller-platform.gitlab.io/storyteller/docs/vocabulary"><body><seq id="c_overlay" epub:textref="../chapter.xhtml" epub:type="chapter"><par id="c-s0" epub:type="storyteller:matched"><text src="../chapter.xhtml#c-s0"/><audio src="../Audio/00001.mp3" clipBegin="0.000s" clipEnd="60.000s"/></par></seq></body></smil>';
  const reportSource = join(request.workDir, "report-source.epub");
  const reportUpgraded = join(request.workDir, "report-upgraded.epub");
  const reportMarked = join(request.workDir, "report-marked.epub");
  await zip(reportSource, { ...source, "OPS/book.opf": source["OPS/book.opf"].replace("NEW TITLE", "OLD TITLE") });
  await upgradeEpub(reportSource, reportUpgraded, { removeNcx: false });
  await markup(reportUpgraded, reportMarked, { granularity: "sentence", primaryLocale: new Intl.Locale("en") });
  const oldEpub = await Epub.from(reportMarked);
  let spine;
  try {
    spine = (await classifySpine(oldEpub, { locale: new Intl.Locale("en") })).map(({ index, href, zone, verdict, decidedBy, signals }) => ({
      index,
      href,
      title: null,
      status: href === "chapter.xhtml" ? "aligned" : chapterAligned({ verdict, decidedBy }, null, true) ? "not-found" : "excluded",
      classification: { zone, verdict, decidedBy, signals },
      decision: null,
      sentenceCount: href === "chapter.xhtml" ? 1 : href === "page.xhtml" && verdict === "include" ? 2 : 0,
      matchedSentenceCount: href === "chapter.xhtml" ? 1 : 0,
      interpolatedSentenceCount: 0,
      droppedSentenceCount: 0,
      matchedSeconds: href === "chapter.xhtml" ? 60 : 0,
      interpolatedSeconds: 0,
      looseSeconds: 0,
      score: null,
      firstMatch: null,
      lastMatch: null,
      preview: null,
    }));
  } finally {
    oldEpub.discardAndClose();
  }
  const report = { version: 4, aligner: "ctc", autoExclude: true, totals, spine, tracks: [], spans: [], holes: [] };
  // A full run writes container.xml after the overlays and the index drops the identical font.
  await zip(join(request.workDir, "index.epub"), {
    mimetype: source.mimetype,
    "OPS/book.opf": packageWithPage("OLD TITLE", true),
    "OPS/chapter.xhtml": alignedChapter,
    ...(pageBody !== undefined ? { "OPS/page.xhtml": source["OPS/page.xhtml"] } : {}),
    "OPS/toc.ncx": source["OPS/toc.ncx"],
    ...(version === "2.0" ? { "OPS/nav.xhtml": "upgraded nav" } : {}),
    "OPS/cover.xhtml": source["OPS/cover.xhtml"].replace("NEW COVER", "OLD COVER"),
    "OPS/cover.png": "OLD COVER",
    "OPS/style.css": "OLD CSS",
    "OPS/MediaOverlays/chapter.smil": smil,
    "OPS/Styles/storyteller-readaloud.css": "alignment style",
    "META-INF/container.xml": container,
    "bookorbit-timings/report.json": JSON.stringify(report),
  });
  const fullRunOrder = [
    "mimetype",
    "OPS/book.opf",
    "OPS/chapter.xhtml",
    "OPS/toc.ncx",
    ...(version === "2.0" ? ["OPS/nav.xhtml"] : []),
    "OPS/cover.xhtml",
    "OPS/cover.png",
    "OPS/font.woff2",
    "OPS/style.css",
    "OPS/MediaOverlays/chapter.smil",
    "OPS/Styles/storyteller-readaloud.css",
    "META-INF/container.xml",
    "OPS/Audio/00001.mp3",
  ];
  const chunkName = "00001.mp3";
  await writeFile(join(request.workDir, "processed-audio", chunkName), "NEW TAGS audio packets");
  const md5 = "a".repeat(32);
  const context = {
    job: {
      epub: { path: sourcePath },
      language: "en",
      granularity: "sentence",
      decisions: { chapters: {}, audio: [] },
      maxOutputBytes: 1_000_000,
      rebuild: {
        ...rebuild,
        chapterFingerprint: fingerprint,
        sourceEntries: [{ href: "OPS/font.woff2", size: 4, crc32: (await crcs(sourcePath))["OPS/font.woff2"], position: version === "2.0" ? 7 : 6 }],
        chunks: [{ name: chunkName, size: 5, sha256, audioMd5: md5 }],
        audioEntries: [{ href: "OPS/Audio/00001.mp3", chunk: chunkName }],
      },
    },
    paths: {
      workDir: request.workDir,
      processedAudioDir: join(request.workDir, "processed-audio"),
      upgradedEpubPath: join(request.workDir, "upgraded.epub"),
      markedEpubPath: join(request.workDir, "marked.epub"),
      outputPath: join(request.workDir, "output.epub"),
      reportPath: join(request.workDir, "report.json"),
    },
    signal: new AbortController().signal,
    event() {},
  };
  return { request, source, sourcePath, alignedChapter, smil, fullRunOrder, md5, context, report };
}

async function runReplayFixture(sandbox, { request, context }) {
  await rm(join(context.paths.processedAudioDir, "00001.mp3"));
  request.rebuild = {
    ...context.job.rebuild,
    chunks: rebuild.chunks,
    audioEntries: [
      { href: "OPS/Audio/00001.mp3", chunk: rebuild.chunks[0].name },
      { href: "OPS/Audio/00002.mp3", chunk: rebuild.chunks[1].name },
    ],
  };
  return run(sandbox, request);
}

for (const version of ["2.0", "3.0"])
  test(`metadata replay upgrades EPUB ${version} and uses current title, cover and newly tagged chunks`, async () => {
    const { rebuildFromIndex, RebuildMismatchError } = await import("../dist/rebuild.js");
    const sandbox = makeSandbox();
    try {
      const { context, source, sourcePath, alignedChapter, smil, fullRunOrder, md5 } = await replayFixture(sandbox, version);
      const referenceUpgraded = join(context.paths.workDir, "reference-upgraded.epub");
      const referenceMarked = join(context.paths.workDir, "reference-marked.epub");
      await upgradeEpub(sourcePath, referenceUpgraded, { removeNcx: false });
      await markup(referenceUpgraded, referenceMarked, { primaryLocale: new Intl.Locale("en"), granularity: "sentence" });
      const checked = [];
      await rebuildFromIndex(context, async (path) => {
        checked.push(path);
        return md5;
      });
      assert.equal(checked.length, 1);
      const output = await yauzl.open(context.paths.outputPath);
      const contents = {};
      for await (const entry of output) {
        const buffers = [];
        for await (const chunk of await entry.openReadStream()) buffers.push(chunk);
        contents[entry.filename] = Buffer.concat(buffers).toString();
      }
      await output.close();
      assert.match(contents["OPS/book.opf"], /NEW TITLE/);
      assert.doesNotMatch(contents["OPS/book.opf"], /OLD TITLE/);
      assert.match(contents["OPS/book.opf"], /media-overlay="c_overlay"/);
      assert.match(contents["OPS/book.opf"], /refines="#c_overlay"/);
      assert.match(contents["OPS/book.opf"], /media:active-class/);
      assert.equal(contents["OPS/chapter.xhtml"], alignedChapter);
      assert.equal(contents["OPS/MediaOverlays/chapter.smil"], smil);
      assert.equal(contents["OPS/cover.png"], "NEW COVER");
      assert.match(contents["OPS/cover.xhtml"], /NEW COVER/);
      assert.doesNotMatch(contents["OPS/cover.xhtml"], /OLD COVER/);
      assert.equal((await crcs(context.paths.outputPath))["OPS/cover.xhtml"], (await crcs(referenceMarked))["OPS/cover.xhtml"]);
      assert.equal(contents["OPS/style.css"], "NEW CSS");
      assert.equal(contents["OPS/Audio/00001.mp3"], "NEW TAGS audio packets");
      assert.deepEqual(Object.keys(contents), fullRunOrder);
      await zip(sourcePath, { ...source, "OPS/chapter.xhtml": source["OPS/chapter.xhtml"].replace("<p>", '<p id="changed">') });
      await assert.rejects(
        rebuildFromIndex(context, async () => md5),
        RebuildMismatchError,
      );
    } finally {
      sandbox.cleanup();
    }
  });

test("a title-only source change still replays", async () => {
  const { rebuildFromIndex } = await import("../dist/rebuild.js");
  const sandbox = makeSandbox();
  try {
    const { context, source, sourcePath } = await replayFixture(sandbox);
    source["OPS/cover.png"] = "OLD COVER";
    source["OPS/cover.xhtml"] = source["OPS/cover.xhtml"].replace("NEW COVER", "OLD COVER");
    source["OPS/style.css"] = "OLD CSS";
    await zip(sourcePath, source);
    const chunk = context.job.rebuild.chunks[0];
    await writeFile(join(context.paths.processedAudioDir, chunk.name), "audio");
    context.job.rebuild.chunks = [{ name: chunk.name, size: 5, sha256 }];
    await rebuildFromIndex(context);
    const output = await archiveContents(context.paths.outputPath);
    assert.match(output["OPS/book.opf"], /NEW TITLE/);
    assert.match(output["OPS/book.opf"], /media-overlay="c_overlay"/);
    assert.equal(output["OPS/Audio/00001.mp3"], "audio");
  } finally {
    sandbox.cleanup();
  }
});

test("a not-found chapter without an overlay replays after a title-only change", async () => {
  const { rebuildFromIndex } = await import("../dist/rebuild.js");
  const sandbox = makeSandbox();
  try {
    const { context, source, sourcePath, md5, report } = await replayFixture(sandbox, "3.0", {
      pageBody: "<p>The Calamitous Bob.</p><p>A story by its author.</p>",
      guide: false,
    });
    const stored = report.spine.find((item) => item.href === "page.xhtml");
    assert.equal(stored.status, "not-found");
    assert.equal(stored.sentenceCount, 2);
    assert.equal(stored.classification.verdict, "include");
    assert.equal(stored.classification.decidedBy, null);
    const index = await archiveContents(join(context.paths.workDir, context.job.rebuild.indexEntry));
    assert.doesNotMatch(index["OPS/book.opf"], /media-overlay="page_overlay"/);
    source["OPS/cover.png"] = "OLD COVER";
    source["OPS/cover.xhtml"] = source["OPS/cover.xhtml"].replace("NEW COVER", "OLD COVER");
    source["OPS/style.css"] = "OLD CSS";
    await zip(sourcePath, source);
    await rebuildFromIndex(context, async () => md5);
    const output = await archiveContents(context.paths.outputPath);
    assert.match(output["OPS/book.opf"], /NEW TITLE/);
    assert.doesNotMatch(output["OPS/book.opf"], /media-overlay="page_overlay"/);
    assert.equal(output["OPS/page.xhtml"], index["OPS/page.xhtml"]);
    assert.equal(await readFile(context.paths.reportPath, "utf8"), JSON.stringify(report));
  } finally {
    sandbox.cleanup();
  }
});

test(
  "real retagged audio keeps packet MD5 while rebuild packs its new container",
  { skip: spawnSync("ffmpeg", ["-version"]).status !== 0 },
  async () => {
    const { audioFingerprint } = await import("../dist/audio-fingerprint.js");
    const { rebuildFromIndex } = await import("../dist/rebuild.js");
    const sandbox = makeSandbox();
    try {
      const request = jobRequest(sandbox);
      const processed = join(request.workDir, "processed-audio");
      await mkdir(processed, { recursive: true });
      const original = join(sandbox.book, "original.m4a");
      const tagged = join(processed, "00001.m4a");
      execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=duration=0.2", "-c:a", "aac", original]);
      execFileSync("ffmpeg", ["-v", "error", "-i", original, "-map", "0:a", "-c", "copy", "-metadata", "title=A new and longer title", tagged]);
      const signal = new AbortController().signal;
      const audioMd5 = await audioFingerprint(original, signal);
      assert.equal(await audioFingerprint(tagged, signal), audioMd5);
      const before = await readFile(original);
      const after = await readFile(tagged);
      const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
      assert.notEqual(hash(before), hash(after));
      await zip(join(request.workDir, "index.epub"), { ...content, "bookorbit-timings/report.json": JSON.stringify({ version: 4, totals }) });
      const context = {
        job: {
          maxOutputBytes: 1_000_000,
          rebuild: {
            ...rebuild,
            chunks: [{ name: "00001.m4a", size: before.length, sha256: hash(before), audioMd5 }],
            audioEntries: [{ href: "OPS/a.m4a", chunk: "00001.m4a" }],
          },
        },
        paths: {
          workDir: request.workDir,
          processedAudioDir: processed,
          outputPath: join(request.workDir, "output.epub"),
          reportPath: join(request.workDir, "report.json"),
        },
        signal,
        event() {},
      };
      await rebuildFromIndex(context);
      const archive = await yauzl.open(context.paths.outputPath);
      try {
        let found = false;
        for await (const entry of archive)
          if (entry.filename === "OPS/a.m4a") {
            const buffers = [];
            for await (const bytes of await entry.openReadStream()) buffers.push(bytes);
            assert.deepEqual(Buffer.concat(buffers), after);
            found = true;
          }
        assert(found);
      } finally {
        await archive.close();
      }
    } finally {
      sandbox.cleanup();
    }
  },
);

test("shared chapter fingerprint fixtures match fixed server parity digests", async () => {
  const { sourceChapterFingerprint } = await import("../dist/rebuild-metadata.js");
  const fixtures = JSON.parse(await readFile(new URL("./fixtures/chapter-fingerprints.json", import.meta.url), "utf8"));
  const sandbox = makeSandbox();
  try {
    for (const fixture of fixtures) {
      const path = join(sandbox.book, "parity.epub");
      await zip(path, fixture.entries);
      const archive = await yauzl.open(path);
      try {
        const entries = [];
        for await (const entry of archive) entries.push(entry);
        assert.equal(await sourceChapterFingerprint(entries), fixture.expected, fixture.name);
      } finally {
        await archive.close();
      }
    }
  } finally {
    sandbox.cleanup();
  }
});

test("legacy textFingerprint is ignored and chapterFingerprint is validated", async () => {
  const sandbox = makeSandbox();
  try {
    const request = jobRequest(sandbox, { rebuild: { ...rebuild, textFingerprint: { obsolete: true } } });
    const validated = validateRequest(request);
    assert.equal(validated.rebuild.chapterFingerprint, undefined);
    assert.equal(validated.rebuild.textFingerprint, undefined);
    assert.throws(() => validateRequest({ ...request, rebuild: { ...rebuild, chapterFingerprint: "bad" } }));
    assert.equal(
      validateRequest({ ...request, rebuild: { ...rebuild, chapterFingerprint: "a".repeat(64) } }).rebuild.chapterFingerprint,
      "a".repeat(64),
    );
  } finally {
    sandbox.cleanup();
  }
});

for (const change of ["linear", "guide"])
  test(`replay ${change} exclusion drift falls back to full alignment`, async () => {
    const sandbox = makeSandbox();
    try {
      const { request, context, source, sourcePath, report } = await replayFixture(sandbox, "3.0", {
        ...(change === "guide" ? { pageBody: "<p>Hello from a text-bearing page.</p>" } : {}),
      });
      if (change === "guide") {
        const stored = report.spine.find((item) => item.href === "page.xhtml");
        assert.equal(stored.classification.verdict, "exclude");
        assert.equal(stored.classification.decidedBy.source, "guide");
      }
      source["OPS/book.opf"] =
        change === "linear"
          ? source["OPS/book.opf"].replace('<itemref idref="c"/>', '<itemref idref="c" linear="no"/>')
          : source["OPS/book.opf"].replace(/<guide>.*?<\/guide>/, "");
      await zip(sourcePath, source);
      const result = await runReplayFixture(sandbox, { request, context });
      assert.equal(result.status, "completed", result.error);
      const fallback = result.events.find((event) => event.code === "rebuild_mismatch_fallback");
      assert(fallback, "exclusion changes must not reuse the timing index");
      assert.match(fallback.data.reason, /Chapter exclusion changed/);
      assert.match(fallback.data.reason, change === "linear" ? /chapter.xhtml/ : /page.xhtml/);
      assert.deepEqual(
        stagesRun(sandbox, request.jobId).map((entry) => entry.stage),
        ["preparing_audio", "generating_emissions", "marking_up_ebook", "aligning"],
      );
    } finally {
      sandbox.cleanup();
    }
  });

for (const [storedDecision, currentDecision, guide, replays] of [
  ["included", "included", true, true],
  ["approved", "approved", true, true],
  ["excluded", "excluded", false, true],
  ["included", null, true, false],
  [null, "included", true, false],
  ["excluded", null, false, false],
  [null, "excluded", false, false],
])
  test(`replay compares stored ${storedDecision} and current ${currentDecision} decisions with guide=${guide}`, async () => {
    const { rebuildFromIndex, RebuildMismatchError } = await import("../dist/rebuild.js");
    const sandbox = makeSandbox();
    try {
      const { context, md5, report } = await replayFixture(sandbox, "3.0", {
        pageBody: "<p>First sentence.</p><p>Second sentence.</p>",
        guide,
      });
      const stored = report.spine.find((item) => item.href === "page.xhtml");
      assert.equal(stored.classification.verdict, guide ? "exclude" : "include");
      stored.decision = storedDecision;
      stored.status = chapterAligned(stored.classification, storedDecision, true) ? "not-found" : "excluded";
      const indexPath = join(context.paths.workDir, context.job.rebuild.indexEntry);
      const entries = await archiveContents(indexPath);
      entries[context.job.rebuild.reportEntry] = JSON.stringify(report);
      await zip(indexPath, entries);
      if (currentDecision !== null) context.job.decisions.chapters["page.xhtml"] = currentDecision;
      if (replays) {
        await rebuildFromIndex(context, async () => md5);
        const output = await archiveContents(context.paths.outputPath);
        assert.doesNotMatch(output["OPS/book.opf"], /media-overlay="page_overlay"/);
      } else
        await assert.rejects(
          rebuildFromIndex(context, async () => md5),
          {
            name: RebuildMismatchError.name,
            message: "Chapter exclusion changed: page.xhtml",
          },
        );
    } finally {
      sandbox.cleanup();
    }
  });

for (const [kind, change] of [
  ["missing report", () => undefined],
  ["invalid JSON", () => "{"],
  ["null report", () => null],
  ["missing spine", ({ spine, ...report }) => report],
  ["non-array spine", (report) => ({ ...report, spine: {} })],
  ["short spine", (report) => ({ ...report, spine: report.spine.slice(0, -1) })],
  ["long spine", (report) => ({ ...report, spine: [...report.spine, report.spine[0]] })],
  ["missing spine item", (report) => ({ ...report, spine: [null, ...report.spine.slice(1)] })],
  ["index disagreement", (report) => ({ ...report, spine: [{ ...report.spine[0], index: 1 }, ...report.spine.slice(1)] })],
  ["href disagreement", (report) => ({ ...report, spine: [{ ...report.spine[0], href: "other.xhtml" }, ...report.spine.slice(1)] })],
  ["missing classification", (report) => ({ ...report, spine: [{ ...report.spine[0], classification: null }, ...report.spine.slice(1)] })],
])
  test(`replay with ${kind} falls back to full alignment`, async () => {
    const sandbox = makeSandbox();
    try {
      const fixture = await replayFixture(sandbox);
      const { context, report } = fixture;
      const indexPath = join(context.paths.workDir, context.job.rebuild.indexEntry);
      const entries = await archiveContents(indexPath);
      const changed = change(report);
      if (changed === undefined) delete entries[context.job.rebuild.reportEntry];
      else entries[context.job.rebuild.reportEntry] = typeof changed === "string" ? changed : JSON.stringify(changed);
      await zip(indexPath, entries);
      const result = await runReplayFixture(sandbox, fixture);
      assert.equal(result.status, "completed", result.error);
      assert(result.events.some((event) => event.code === "rebuild_mismatch_fallback"));
      assert(!result.events.some((event) => event.code === "rebuild_from_index"));
      assert.deepEqual(
        stagesRun(sandbox, fixture.request.jobId).map((entry) => entry.stage),
        ["preparing_audio", "generating_emissions", "marking_up_ebook", "aligning"],
      );
    } finally {
      sandbox.cleanup();
    }
  });

for (const declaredSize of [0, 16 * 1024 * 1024 + 1])
  test(`replay bounds report bytes with declared size ${declaredSize}`, async () => {
    const { replayMetadata } = await import("../dist/rebuild-metadata.js");
    const { RebuildMismatchError } = await import("../dist/rebuild-error.js");
    const sandbox = makeSandbox();
    try {
      const { context } = await replayFixture(sandbox);
      const contents = await archiveContents(join(context.paths.workDir, context.job.rebuild.indexEntry));
      const entries = Object.entries(contents).map(([filename, text]) => ({
        filename,
        uncompressedSize: Buffer.byteLength(text),
        openReadStream: async () => Readable.from([text]),
      }));
      const report = entries.find((entry) => entry.filename === context.job.rebuild.reportEntry);
      report.uncompressedSize = declaredSize;
      report.openReadStream = async () => Readable.from([Buffer.alloc(16 * 1024 * 1024), Buffer.from(" ")]);
      await assert.rejects(replayMetadata(entries, entries, context), {
        name: RebuildMismatchError.name,
        message: declaredSize ? "Missing or oversized EPUB document" : "Oversized EPUB document",
      });
    } finally {
      sandbox.cleanup();
    }
  });

for (const outcome of ["success", "mismatch", "audio mismatch"])
  test(`replay isolates cached full-run files and cleans scratch after ${outcome}`, async () => {
    const { rebuildFromIndex } = await import("../dist/rebuild.js");
    const { RebuildMismatchError } = await import("../dist/rebuild-error.js");
    const sandbox = makeSandbox();
    try {
      const { context, source, sourcePath, md5 } = await replayFixture(sandbox);
      if (outcome === "mismatch") {
        source["OPS/book.opf"] = source["OPS/book.opf"].replace('id="c"', 'id="changed"').replace('idref="c"', 'idref="changed"');
        await zip(sourcePath, source);
      }
      const cached = [context.paths.upgradedEpubPath, context.paths.markedEpubPath, join(context.paths.workDir, ".done-marking_up_ebook")];
      for (const path of cached) await writeFile(path, "cached output or marker");
      const scratch = ["rebuild-upgraded.epub", "rebuild-marked.epub"].map((name) => join(context.paths.workDir, name));
      for (const path of scratch) await writeFile(path, "interrupted replay");
      if (outcome === "audio mismatch") context.job.rebuild.chunks[0].audioMd5 = "b".repeat(32);
      if (outcome !== "success")
        await assert.rejects(
          rebuildFromIndex(context, async () => md5),
          RebuildMismatchError,
        );
      else await rebuildFromIndex(context, async () => md5);
      for (const path of cached) assert.ok((await readFile(path, "utf8")) === "cached output or marker", `${path} must remain unchanged`);
      for (const path of scratch) await assert.rejects(stat(path), { code: "ENOENT" });
    } finally {
      sandbox.cleanup();
    }
  });

for (const change of ["spine id", "cover media-type", "malformed percent"])
  test(`replay handles ${change} changes safely`, async () => {
    const { rebuildFromIndex } = await import("../dist/rebuild.js");
    const { RebuildMismatchError } = await import("../dist/rebuild-error.js");
    const sandbox = makeSandbox();
    try {
      const { context, source, sourcePath, md5 } = await replayFixture(sandbox);
      source["OPS/book.opf"] =
        change === "spine id"
          ? source["OPS/book.opf"].replace('id="c"', 'id="changed"').replace('idref="c"', 'idref="changed"')
          : change === "cover media-type"
            ? source["OPS/book.opf"].replace('media-type="image/png"', 'media-type="image/jpeg"')
            : source["OPS/book.opf"].replace('href="chapter.xhtml"', 'href="chapter%.xhtml"');
      await zip(sourcePath, source);
      if (change === "cover media-type") {
        await rebuildFromIndex(context, async () => md5);
        const output = await archiveContents(context.paths.outputPath);
        assert.match(output["OPS/book.opf"], /href="cover.png" media-type="image\/jpeg"/);
        assert.equal(output["OPS/cover.png"], "NEW COVER");
      } else
        await assert.rejects(
          rebuildFromIndex(context, async () => md5),
          RebuildMismatchError,
        );
    } finally {
      sandbox.cleanup();
    }
  });

test("chapter XML entity warnings stay off stderr and fatal XML still throws", async (t) => {
  const { sourceChapterFingerprint } = await import("../dist/rebuild-metadata.js");
  const entry = (filename, text) => ({ filename, uncompressedSize: Buffer.byteLength(text), openReadStream: async () => Readable.from([text]) });
  const entries = [
    entry("META-INF/container.xml", '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>'),
    entry("book.opf", '<package><manifest><item id="c" href="chapter.xhtml"/></manifest><spine><itemref idref="c"/></spine></package>'),
    entry("chapter.xhtml", "<html><body><p>Hello&nbsp;world</p></body></html>"),
  ];
  const errors = t.mock.method(console, "error", () => {});
  const stderr = t.mock.method(process.stderr, "write", () => true);
  try {
    assert.match(await sourceChapterFingerprint(entries), /^[a-f0-9]{64}$/);
    assert.equal(errors.mock.callCount(), 0);
    assert.equal(stderr.mock.callCount(), 0);
    entries[2] = entry("chapter.xhtml", '<html a="1" a="2"><body/></html>');
    await assert.rejects(sourceChapterFingerprint(entries), { name: "ParseError" });
    assert.equal(errors.mock.callCount(), 0);
    assert.equal(stderr.mock.callCount(), 0);
  } finally {
    errors.mock.restore();
    stderr.mock.restore();
  }
});

async function archiveContents(path) {
  const archive = await yauzl.open(path);
  try {
    const contents = {};
    for await (const entry of archive) {
      const chunks = [];
      for await (const bytes of await entry.openReadStream()) chunks.push(bytes);
      contents[entry.filename] = Buffer.concat(chunks).toString();
    }
    return contents;
  } finally {
    await archive.close();
  }
}

test("an explicit exclusion of a previously aligned chapter prevents replay", async () => {
  const { rebuildFromIndex } = await import("../dist/rebuild.js");
  const { RebuildMismatchError } = await import("../dist/rebuild-error.js");
  const sandbox = makeSandbox();
  try {
    const { context, md5 } = await replayFixture(sandbox);
    context.job.decisions.chapters["chapter.xhtml"] = "excluded";
    await assert.rejects(
      rebuildFromIndex(context, async () => md5),
      RebuildMismatchError,
    );
  } finally {
    sandbox.cleanup();
  }
});

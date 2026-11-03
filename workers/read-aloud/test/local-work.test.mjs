import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { loadConfig } from "../dist/config.js";
import { prepareLocalRun, pruneLocalWork, publishOutputs, runFolders } from "../dist/local-work.js";
import { TERMINAL, jobRequest, makeSandbox, stagesRun, startTestWorker, waitForJob } from "./helpers.mjs";

const TOKEN = "0123456789abcdef0123";

describe("local work config", () => {
  test("is off by default and keeps temp files beside the local folder when set", () => {
    const shared = loadConfig({ READ_ALOUD_WORKER_TOKEN: TOKEN, READ_ALOUD_WORK_ROOT: "/data/read-aloud/jobs" });
    assert.equal(shared.localWorkRoot, null);
    assert.equal(shared.tmpDir, "/data/read-aloud/tmp");

    const local = loadConfig({
      READ_ALOUD_WORKER_TOKEN: TOKEN,
      READ_ALOUD_WORK_ROOT: "/data/read-aloud/jobs",
      READ_ALOUD_LOCAL_WORK_ROOT: " /ssd/read-aloud/jobs/ ",
    });
    assert.equal(local.localWorkRoot, "/ssd/read-aloud/jobs");
    assert.equal(local.tmpDir, "/ssd/read-aloud/tmp");
  });

  test("the same folder as the shared one turns it off, and a relative path is refused", () => {
    const same = loadConfig({ READ_ALOUD_WORKER_TOKEN: TOKEN, READ_ALOUD_WORK_ROOT: "/data/jobs", READ_ALOUD_LOCAL_WORK_ROOT: "/data/jobs/" });
    assert.equal(same.localWorkRoot, null);
    assert.throws(() => loadConfig({ READ_ALOUD_WORKER_TOKEN: TOKEN, READ_ALOUD_LOCAL_WORK_ROOT: "jobs" }), /READ_ALOUD_LOCAL_WORK_ROOT/);
  });

  test("a link to the shared folder also turns it off", () => {
    const sandbox = makeSandbox();
    try {
      const link = join(sandbox.root, "jobs-link");
      symlinkSync(sandbox.workRoot, link);
      const config = loadConfig({ READ_ALOUD_WORKER_TOKEN: TOKEN, READ_ALOUD_WORK_ROOT: sandbox.workRoot, READ_ALOUD_LOCAL_WORK_ROOT: link });
      assert.equal(config.localWorkRoot, null);
    } finally {
      sandbox.cleanup();
    }
  });
});

describe("local work folders", () => {
  let sandbox;

  before(() => {
    sandbox = makeSandbox();
  });

  after(() => sandbox.cleanup());

  test("runFolders publishes into the shared folder only when local work is on", () => {
    const shared = join(sandbox.workRoot, "job");
    assert.deepEqual(runFolders({ localWorkRoot: null }, shared, "job"), { workDir: shared, publishDir: null });
    assert.deepEqual(runFolders({ localWorkRoot: "/ssd/jobs" }, shared, "job"), { workDir: "/ssd/jobs/job", publishDir: shared });
  });

  test("prune removes local folders the server dropped, and keeps the running job and anything else", async () => {
    const localRoot = join(sandbox.root, "prune-local");
    const [gone, kept, running] = [randomUUID(), randomUUID(), randomUUID()];
    for (const id of [gone, kept, running]) mkdirSync(join(localRoot, id, "processed-audio"), { recursive: true });
    mkdirSync(join(localRoot, "not-a-job"), { recursive: true });
    mkdirSync(join(sandbox.workRoot, kept), { recursive: true });

    assert.equal(await pruneLocalWork(localRoot, sandbox.workRoot, running), 1);
    assert.deepEqual(readdirSync(localRoot).sort(), [kept, running, "not-a-job"].sort());
  });

  test("prune keeps everything while the shared folder is missing, as when its share is not mounted", async () => {
    const localRoot = join(sandbox.root, "prune-unmounted");
    const id = randomUUID();
    mkdirSync(join(localRoot, id), { recursive: true });
    assert.equal(await pruneLocalWork(localRoot, join(sandbox.root, "not-mounted", "jobs"), "other"), 0);
    assert.ok(existsSync(join(localRoot, id)));
  });

  test("prune keeps a folder whose shared folder cannot be checked", async () => {
    const localRoot = join(sandbox.root, "prune-unreadable-local");
    const sharedRoot = join(sandbox.root, "prune-unreadable-shared");
    const id = randomUUID();
    mkdirSync(join(localRoot, id), { recursive: true });
    mkdirSync(join(sharedRoot, id), { recursive: true });
    chmodSync(sharedRoot, 0o000);
    try {
      assert.equal(await pruneLocalWork(localRoot, sharedRoot, "other"), 0);
    } finally {
      chmodSync(sharedRoot, 0o755);
    }
    assert.ok(existsSync(join(localRoot, id)));
  });

  test("an earlier run's published output is cleared before the next run", async () => {
    const jobId = randomUUID();
    const shared = join(sandbox.workRoot, jobId);
    mkdirSync(join(shared, "processed-audio"), { recursive: true });
    writeFileSync(join(shared, "output.epub"), "old");
    writeFileSync(join(shared, "report.json"), "{}");
    const config = { localWorkRoot: join(sandbox.root, "clear-local"), workRoot: sandbox.workRoot };

    await prepareLocalRun(config, runFolders(config, shared, jobId), { jobId, rebuild: null });
    assert.deepEqual(readdirSync(shared), ["processed-audio"]);
  });

  test("a rebuild's timing index is copied in, and a missing one is left for the runner to fall back on", async () => {
    const localRoot = join(sandbox.root, "rebuild-local");
    const jobId = randomUUID();
    const shared = join(sandbox.workRoot, jobId);
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, "index.epub"), "timing-index");
    const config = { localWorkRoot: localRoot, workRoot: sandbox.workRoot };
    const folders = runFolders(config, shared, jobId);

    await prepareLocalRun(config, folders, { jobId, rebuild: { indexEntry: "index.epub" } });
    assert.equal(readFileSync(join(folders.workDir, "index.epub"), "utf8"), "timing-index");

    const otherId = randomUUID();
    const other = runFolders(config, join(sandbox.workRoot, otherId), otherId);
    await prepareLocalRun(config, other, { jobId: otherId, rebuild: { indexEntry: "index.epub" } });
    assert.ok(!existsSync(join(other.workDir, "index.epub")));

    rmSync(join(shared, "index.epub"));
    await prepareLocalRun(config, folders, { jobId, rebuild: { indexEntry: "index.epub" } });
    assert.ok(!existsSync(join(folders.workDir, "index.epub")), "an earlier attempt's copy does not stand in for a missing index");
  });

  test("publishing replaces earlier output and leaves no partial files", async () => {
    const local = join(sandbox.root, "publish-local");
    const shared = join(sandbox.root, "publish-shared");
    mkdirSync(local, { recursive: true });
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, "output.epub"), "old");
    mkdirSync(join(shared, "processed-audio"), { recursive: true });
    writeFileSync(join(shared, "processed-audio", "stale.mp4"), "stale");
    mkdirSync(join(local, "processed-audio"), { recursive: true });
    writeFileSync(join(local, "processed-audio", "00001-00001.mp4"), "chunk");
    writeFileSync(join(local, "processed-audio", "00001-00001.source.json"), "{}");
    writeFileSync(join(local, "output.epub"), "new-output");
    writeFileSync(join(local, "report.json"), "{}");
    const paths = {
      workDir: local,
      processedAudioDir: join(local, "processed-audio"),
      outputPath: join(local, "output.epub"),
      reportPath: join(local, "report.json"),
    };

    await publishOutputs(paths, shared, "job");
    assert.equal(readFileSync(join(shared, "output.epub"), "utf8"), "new-output");
    assert.deepEqual(readdirSync(shared).sort(), ["output.epub", "processed-audio", "report.json"]);
    assert.deepEqual(readdirSync(join(shared, "processed-audio")).sort(), ["00001-00001.mp4", "00001-00001.source.json"]);
  });

  test("publishing again copies only the audio chunks that changed", async () => {
    const local = join(sandbox.root, "resync-local");
    const shared = join(sandbox.root, "resync-shared");
    const audio = join(local, "processed-audio");
    mkdirSync(audio, { recursive: true });
    writeFileSync(join(audio, "a.mp4"), "same");
    writeFileSync(join(audio, "b.mp4"), "before");
    writeFileSync(join(local, "output.epub"), "out");
    writeFileSync(join(local, "report.json"), "{}");
    const paths = { workDir: local, processedAudioDir: audio, outputPath: join(local, "output.epub"), reportPath: join(local, "report.json") };
    await publishOutputs(paths, shared, "job");
    const unchanged = statSync(join(shared, "processed-audio", "a.mp4")).ino;

    writeFileSync(join(audio, "b.mp4"), "after!");
    utimesSync(join(audio, "b.mp4"), new Date(), new Date(Date.now() + 5_000));
    await publishOutputs(paths, shared, "job");
    assert.equal(statSync(join(shared, "processed-audio", "a.mp4")).ino, unchanged);
    assert.equal(readFileSync(join(shared, "processed-audio", "b.mp4"), "utf8"), "after!");
  });
});

describe("a job with local work", () => {
  let sandbox;
  let client;
  let localRoot;

  before(async () => {
    sandbox = makeSandbox();
    localRoot = join(sandbox.root, "local", "jobs");
    client = await startTestWorker(sandbox, { localWorkRoot: localRoot });
  });

  after(async () => {
    await client.close();
    sandbox.cleanup();
  });

  test("runs in the local folder and puts only what the server reads in the shared one", async () => {
    const request = jobRequest(sandbox);
    assert.equal((await client.call("POST", "/v1/jobs", request)).status, 202);
    const job = await waitForJob(client, request.jobId, (body) => TERMINAL.has(body.status));
    assert.equal(job.status, "completed", JSON.stringify(job));

    const localDir = join(localRoot, request.jobId);
    assert.deepEqual(readdirSync(request.workDir).sort(), [".worker-event-seq", "output.epub", "processed-audio", "report.json"]);
    assert.equal(readFileSync(join(request.workDir, "output.epub"), "utf8"), "output-epub-bytes");
    assert.ok(existsSync(join(localDir, ".done-aligning")), "stage markers stay with the local cache");
    assert.ok(existsSync(join(localDir, "source-audio", "0001.mp3")));
    assert.equal(stagesRun(sandbox, request.jobId)[0].scratch, join(localDir, "scratch"));
  });

  test("a repeat run reuses the local cache", async () => {
    const request = jobRequest(sandbox);
    await client.call("POST", "/v1/jobs", request);
    await waitForJob(client, request.jobId, (body) => TERMINAL.has(body.status));
    const repeat = await client.call("POST", "/v1/jobs", request);
    assert.equal(repeat.status, 202);
    const reused = (body) => body.events.some((event) => event.code === "stage_skipped" && event.stage === "generating_emissions");
    const job = await waitForJob(client, request.jobId, (body) => TERMINAL.has(body.status) && reused(body));
    assert.equal(job.status, "completed");
  });
});

describe("disk space with local work", () => {
  test("too little room in the shared folder fails the job before the runner starts", async () => {
    const sandbox = makeSandbox();
    const localRoot = join(sandbox.root, "local", "jobs");
    const client = await startTestWorker(sandbox, {
      localWorkRoot: localRoot,
      freeBytes: async (path) => (path.startsWith(localRoot) ? 1e12 : 1_000),
    });
    try {
      const request = jobRequest(sandbox);
      const response = await client.call("POST", "/v1/jobs", request);
      assert.equal(response.body.status, "failed");
      assert.equal(response.body.errorCode, "insufficient_storage");
      assert.match(response.body.error, /shared job folder/);
      assert.deepEqual(stagesRun(sandbox, request.jobId), []);
    } finally {
      await client.close();
      sandbox.cleanup();
    }
  });
});

import { isCtcModelVariant } from "@storyteller-platform/ghost-story/constants";
import {
  READ_ALOUD_MAX_AUDIO_FILES,
  READ_ALOUD_REBUILD_MAX_CHUNKS,
  type ReadAloudRebuildRequest,
  type ReadAloudWorkerRebuildRequest,
  READ_ALOUD_WORKER_STAGES,
  type ReadAloudChapterDecision,
  type ReadAloudDecisions,
  type ReadAloudWorkerStage,
} from "@bookorbit/types";
import { RequestError } from "./paths.js";

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHAPTER_DECISIONS: readonly ReadAloudChapterDecision[] = ["excluded", "included", "approved"];
const MAX_AUDIO_FILES = READ_ALOUD_MAX_AUDIO_FILES;
const MAX_CHAPTER_DECISIONS = 10_000;
const MAX_AUDIO_EXCLUSIONS = 1_000;

export function isJobId(value: string): boolean {
  return JOB_ID.test(value);
}

/**
 * Shape errors mean the server speaks a different protocol than this worker, so they carry
 * `worker_incompatible`. Fields added after protocol 1 shipped default instead of being required.
 */
export function validateRequest(value: unknown): ReadAloudWorkerRebuildRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw incompatible("Request body must be a JSON object");
  const body = value as Record<string, unknown>;
  const jobId = body.jobId;
  if (typeof jobId !== "string" || !isJobId(jobId)) throw incompatible("jobId must be a UUID");
  if (typeof body.epubPath !== "string" || body.epubPath.length === 0) throw incompatible("epubPath must be a string");
  if (typeof body.workDir !== "string" || body.workDir.length === 0) throw incompatible("workDir must be a string");
  const audioPaths = body.audioPaths;
  if (
    !Array.isArray(audioPaths) ||
    audioPaths.length < 1 ||
    audioPaths.length > MAX_AUDIO_FILES ||
    audioPaths.some((path) => typeof path !== "string" || path.length === 0)
  ) {
    throw incompatible(`audioPaths must list 1 to ${MAX_AUDIO_FILES} paths`);
  }
  if (typeof body.language !== "string" || body.language.length === 0 || body.language.length > 50) throw incompatible("language must be a string");
  if (body.granularity !== "sentence" && body.granularity !== "word") throw incompatible("granularity must be sentence or word");
  if (body.model !== "quartznet15x5") throw incompatible("model must be quartznet15x5");
  if (!isNonNegativeInteger(body.sourceBytes)) throw incompatible("sourceBytes must be a non-negative integer");
  if (!isNonNegativeInteger(body.maxOutputBytes) || body.maxOutputBytes < 1) throw incompatible("maxOutputBytes must be a positive integer");
  const duration = body.audioDurationSeconds ?? null;
  if (duration !== null && (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0)) {
    throw incompatible("audioDurationSeconds must be null or a non-negative number");
  }
  const resumeFrom = body.resumeFrom ?? null;
  if (resumeFrom !== null && !(READ_ALOUD_WORKER_STAGES as readonly unknown[]).includes(resumeFrom)) {
    throw incompatible(`resumeFrom must be null or one of: ${READ_ALOUD_WORKER_STAGES.join(", ")}`);
  }
  assertSupportedLanguage(body.language);
  return {
    jobId,
    epubPath: body.epubPath,
    audioPaths: audioPaths as string[],
    workDir: body.workDir,
    language: body.language,
    granularity: body.granularity,
    model: body.model,
    sourceBytes: body.sourceBytes,
    audioDurationSeconds: duration,
    maxOutputBytes: body.maxOutputBytes,
    decisions: validateDecisions(body.decisions),
    resumeFrom: resumeFrom as ReadAloudWorkerStage | null,
    rebuild: validateRebuild(body.rebuild),
  };
}

export function quartznetLanguage(language: string): string | null {
  let subtag: string;
  try {
    subtag = new Intl.Locale(language).language;
  } catch {
    return null;
  }
  return isCtcModelVariant(`quartznet15x5_${subtag}`) ? subtag : null;
}

function assertSupportedLanguage(language: string): void {
  if (!quartznetLanguage(language)) {
    throw new RequestError(400, "unsupported_language", "The QuartzNet model has no variant for this language");
  }
}

function validateDecisions(value: unknown): ReadAloudDecisions {
  if (value === undefined || value === null) return { chapters: {}, audio: [] };
  if (typeof value !== "object" || Array.isArray(value)) throw incompatible("decisions must be an object");
  const { chapters = {}, audio = [] } = value as { chapters?: unknown; audio?: unknown };
  if (!chapters || typeof chapters !== "object" || Array.isArray(chapters)) throw incompatible("decisions.chapters must be an object");
  const entries = Object.entries(chapters);
  if (entries.length > MAX_CHAPTER_DECISIONS) throw incompatible("decisions.chapters has too many entries");
  const validChapters: Record<string, ReadAloudChapterDecision> = {};
  for (const [href, decision] of entries) {
    if (!CHAPTER_DECISIONS.includes(decision as ReadAloudChapterDecision)) {
      throw incompatible("decisions.chapters values must be excluded, included or approved");
    }
    validChapters[href] = decision as ReadAloudChapterDecision;
  }
  if (!Array.isArray(audio) || audio.length > MAX_AUDIO_EXCLUSIONS) throw incompatible("decisions.audio must be an array");
  const validAudio = audio.map((entry) => {
    if (!entry || typeof entry !== "object") throw incompatible("decisions.audio entries must be objects");
    const { track, start = null, end = null } = entry as { track?: unknown; start?: unknown; end?: unknown };
    if (typeof track !== "string" || !isOptionalSeconds(start) || !isOptionalSeconds(end)) {
      throw incompatible("decisions.audio entries need a track name and optional start and end seconds");
    }
    return { track, start, end };
  });
  return { chapters: validChapters, audio: validAudio };
}

function isOptionalSeconds(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function incompatible(message: string): RequestError {
  return new RequestError(400, "worker_incompatible", message);
}

export function safeEntry(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 2000 &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.includes(":") &&
    !value.startsWith("/") &&
    value.split("/").every((part) => part !== ".." && part !== "." && part !== "")
  );
}

function validateRebuild(value: unknown): ReadAloudRebuildRequest | null {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw incompatible("rebuild must be an object");
  const body = value as Record<string, unknown>;
  if (!safeEntry(body.indexEntry) || body.indexEntry.includes("/") || !safeEntry(body.reportEntry)) throw incompatible("Invalid rebuild entry path");
  if (!Array.isArray(body.chunks) || body.chunks.length < 1 || body.chunks.length > READ_ALOUD_REBUILD_MAX_CHUNKS)
    throw incompatible("Invalid rebuild chunks");
  const names = new Set<string>();
  const chunks = body.chunks.map((value: unknown) => {
    if (!value || typeof value !== "object") throw incompatible("Invalid rebuild chunk");
    const chunk = value as Record<string, unknown>;
    if (
      !safeEntry(chunk.name) ||
      chunk.name.includes("/") ||
      names.has(chunk.name) ||
      !isNonNegativeInteger(chunk.size) ||
      typeof chunk.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(chunk.sha256) ||
      (chunk.audioMd5 !== undefined && (typeof chunk.audioMd5 !== "string" || !/^[a-f0-9]{32}$/.test(chunk.audioMd5)))
    )
      throw incompatible("Invalid rebuild chunk");
    names.add(chunk.name);
    return {
      name: chunk.name,
      size: chunk.size,
      sha256: chunk.sha256,
      ...(chunk.audioMd5 === undefined ? {} : { audioMd5: chunk.audioMd5 as string }),
    };
  });
  if (!Array.isArray(body.audioEntries) || body.audioEntries.length < 1 || body.audioEntries.length > READ_ALOUD_REBUILD_MAX_CHUNKS)
    throw incompatible("Invalid rebuild audio entries");
  const hrefs = new Set<string>();
  const audioEntries = body.audioEntries.map((value: unknown) => {
    if (!value || typeof value !== "object") throw incompatible("Invalid rebuild audio entry");
    const entry = value as Record<string, unknown>;
    if (
      !safeEntry(entry.href) ||
      entry.href === "mimetype" ||
      entry.href.startsWith("bookorbit-timings/") ||
      hrefs.has(entry.href) ||
      typeof entry.chunk !== "string" ||
      !names.has(entry.chunk)
    )
      throw incompatible("Invalid rebuild audio entry");
    hrefs.add(entry.href);
    return { href: entry.href, chunk: entry.chunk };
  });
  const sourceEntries = body.sourceEntries === undefined ? [] : body.sourceEntries;
  if (!Array.isArray(sourceEntries) || sourceEntries.length > READ_ALOUD_REBUILD_MAX_CHUNKS) throw incompatible("Invalid rebuild source entries");
  for (const value of sourceEntries) {
    if (!value || typeof value !== "object") throw incompatible("Invalid rebuild source entry");
    const entry = value as Record<string, unknown>;
    if (
      !safeEntry(entry.href) ||
      entry.href === "mimetype" ||
      entry.href.startsWith("bookorbit-timings/") ||
      hrefs.has(entry.href) ||
      !isNonNegativeInteger(entry.size) ||
      !isNonNegativeInteger(entry.crc32) ||
      entry.crc32 > 0xffffffff ||
      (entry.position !== undefined && !isNonNegativeInteger(entry.position))
    )
      throw incompatible("Invalid rebuild source entry");
    hrefs.add(entry.href);
  }
  if (body.chapterFingerprint !== undefined && (typeof body.chapterFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(body.chapterFingerprint)))
    throw incompatible("Invalid chapter fingerprint");
  return {
    ...(body.chapterFingerprint === undefined ? {} : { chapterFingerprint: body.chapterFingerprint as string }),
    indexEntry: body.indexEntry,
    reportEntry: body.reportEntry,
    chunks,
    audioEntries,
    ...(body.sourceEntries === undefined ? {} : { sourceEntries: sourceEntries as NonNullable<ReadAloudRebuildRequest["sourceEntries"]> }),
  };
}

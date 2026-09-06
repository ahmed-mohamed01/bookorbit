import { createHash } from 'crypto';
import { basename } from 'path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { describeError } from './reading-alignment-error.util';
import type { RequestUser } from '../../common/types/request-user';
import { appConfig } from '../../config/config';
import { EpubService } from '../reader/epub/epub.service';
import { absoluteSecondsToFilePosition, buildAudioTimeline } from './reading-alignment-audio-timeline.util';
import { computeAnchorFraction } from './reading-alignment-fraction.util';
import { matchTranscript } from './reading-alignment-matcher.util';
import type { SpineText } from './reading-alignment-matcher.util';
import type { ReadingAlignmentPair } from './reading-alignment-pair.service';
import { ReadingAlignmentPairService } from './reading-alignment-pair.service';
import { ReadingAlignmentSyncService } from './reading-alignment-sync.service';
import { ReadingAlignmentRepository } from './reading-alignment.repository';
import { WhisperService } from './whisper.service';

const BUILD_EVENT = 'reading_alignment.build';
// Two anchors are the minimum needed to interpolate a position between them; below that the book is
// unalignable.
const MIN_ANCHORS = 2;
// Global ceiling on concurrent builds across all pairs, so a burst of requests cannot spawn unbounded
// ffmpeg/whisper pipelines at once. Builds are CPU-heavy background work; a small cap is intentional.
const MAX_CONCURRENT_BUILDS = 2;
// After this many consecutive transcription failures with nothing anchored yet, stop and mark the build
// failed: whisper/ffmpeg is almost certainly misconfigured, and continuing would spawn a doomed
// subprocess for every remaining sample.
const EARLY_ABORT_FAILURES = 3;
// Hard ceiling on consecutive failures for a RESUMED build (existing anchors defeat the early-abort
// above): stops a build with an unreachable model from burning a subprocess or download attempt on
// every remaining sample.
const MAX_CONSECUTIVE_FAILURES = 10;
// How far a stored error message is allowed to grow before truncation.
const MAX_ERROR_CHARS = 500;

type SampleOutcome =
  | { kind: 'anchored'; spineIndex: number; fraction: number | null; inserted: boolean }
  | { kind: 'transcribe_failed'; message: string }
  | { kind: 'skipped' };

@Injectable()
export class ReadingAlignmentBuildService {
  private readonly logger = new Logger(ReadingAlignmentBuildService.name);
  // Overlap guard: one build per pair at a time. A second call for either book already building is skipped
  // rather than queued, mirroring the boolean in-flight guard in AudiobookshelfSyncSchedulerService.
  private readonly building = new Set<string>();

  constructor(
    @Inject(appConfig.KEY) private readonly config: ConfigType<typeof appConfig>,
    private readonly repo: ReadingAlignmentRepository,
    private readonly whisper: WhisperService,
    private readonly epub: EpubService,
    private readonly pairService: ReadingAlignmentPairService,
    private readonly syncService: ReadingAlignmentSyncService,
  ) {}

  async buildAlignment(bookId: number, user: RequestUser, force = false): Promise<void> {
    const pair = await this.pairService.resolveAlignmentPair(bookId);
    if (!pair) {
      this.logger.log(`[${BUILD_EVENT}] [end] bookId=${bookId} status=unalignable reason=no_pair - edition link required`);
      return;
    }

    const pairKey = `${pair.textBookId}:${pair.audioBookId}`;
    if (this.building.has(pairKey)) {
      this.logger.log(
        `[${BUILD_EVENT}] [end] bookId=${bookId} textBookId=${pair.textBookId} audioBookId=${pair.audioBookId} status=skipped reason=in_flight - build already in flight`,
      );
      return;
    }
    // Reject rather than queue when the global cap is reached; the check and the add below run without an
    // intervening await, so concurrent callers cannot both pass it.
    if (this.building.size >= MAX_CONCURRENT_BUILDS) {
      this.logger.log(
        `[${BUILD_EVENT}] [end] bookId=${bookId} textBookId=${pair.textBookId} audioBookId=${pair.audioBookId} status=skipped reason=at_capacity inFlight=${this.building.size} - build capacity reached`,
      );
      return;
    }
    this.building.add(pairKey);
    try {
      await this.runBuild(pair, user, force);
    } finally {
      this.building.delete(pairKey);
    }
  }

  // Whether a new build would be rejected by the global concurrency cap right now, so the status service
  // can report an honest "busy" instead of a spinner that resolves to nothing.
  isAtCapacity(): boolean {
    return this.building.size >= MAX_CONCURRENT_BUILDS;
  }

  private async runBuild(pair: ReadingAlignmentPair, user: RequestUser, force = false): Promise<void> {
    const { textBookId, audioBookId } = pair;
    if (!this.config.readingAlignmentEnabled) {
      this.logger.log(
        `[${BUILD_EVENT}] [end] textBookId=${textBookId} audioBookId=${audioBookId} status=skipped reason=disabled - reading alignment disabled`,
      );
      return;
    }
    if (!this.whisper.isAvailable()) {
      this.logger.log(
        `[${BUILD_EVENT}] [end] textBookId=${textBookId} audioBookId=${audioBookId} status=skipped reason=whisper_unavailable - whisper not configured`,
      );
      return;
    }

    const [ebook, audioFiles] = await Promise.all([this.repo.findEbookFile(textBookId), this.repo.resolveAudioFilesWithPaths(audioBookId)]);

    if (!ebook || audioFiles.length === 0) {
      const alignment = await this.repo.upsertAlignment(textBookId, audioBookId, {
        ebookFileId: ebook?.id ?? null,
        status: 'unalignable',
      });
      this.logger.log(
        `[${BUILD_EVENT}] [end] textBookId=${textBookId} audioBookId=${audioBookId} alignmentId=${alignment.id} status=unalignable hasEpub=${Boolean(ebook)} hasAudio=${audioFiles.length > 0} - missing format, cannot align`,
      );
      return;
    }

    const sampleIntervalSec = this.config.readingAlignmentSampleIntervalSec;
    const clipSeconds = this.config.readingAlignmentClipSeconds;
    // Store just the model file name, not the full configured path: the value is informational, and a
    // long path would overflow the whisper_model column and fail the insert (crashing every build).
    const whisperModel = this.config.whisperModel ? basename(this.config.whisperModel) : null;

    const audioContentHash = this.computeHash(audioFiles.map((f) => [f.fileId, f.absolutePath, f.durationSeconds]));
    const epubContentHash = this.computeHash([ebook.id, ebook.absolutePath, ebook.sizeBytes]);

    const existing = await this.repo.getAlignmentByPair(textBookId, audioBookId);
    const hashesMatch = Boolean(existing && existing.audioContentHash === audioContentHash && existing.epubContentHash === epubContentHash);

    if (existing && hashesMatch && existing.status === 'ready' && !force) {
      this.logger.log(
        `[${BUILD_EVENT}] [end] textBookId=${textBookId} audioBookId=${audioBookId} alignmentId=${existing.id} status=skipped reason=up_to_date - already built`,
      );
      // A relink of an already-built pair reaches here: the pair just became alignable again, so the
      // one-shot reconcile still runs (it logs and swallows its own failures).
      await this.syncService.reconcilePairOnReady({ textBookId, audioBookId }, user.id);
      return;
    }

    const timeline = buildAudioTimeline(audioFiles.map((f) => ({ fileId: f.fileId, durationSeconds: f.durationSeconds })));
    // A missing per-file duration shifts every later file's absolute offset, so anchors would be placed
    // against the wrong audio seconds. Refuse rather than build a silently mismapped alignment.
    if (timeline.incomplete) {
      const alignment = await this.repo.upsertAlignment(textBookId, audioBookId, {
        ebookFileId: ebook.id,
        status: 'unalignable',
        error: 'one or more audio files have an unknown duration',
      });
      this.logger.log(
        `[${BUILD_EVENT}] [end] textBookId=${textBookId} audioBookId=${audioBookId} alignmentId=${alignment.id} status=unalignable reason=incomplete_timeline - missing audio durations`,
      );
      return;
    }
    const totalSeconds = timeline.totalSeconds;
    const samplesTotal = Math.floor(totalSeconds / sampleIntervalSec) + 1;

    // Resume when the same content was mid-build and made real progress - whether the row is still
    // 'building' (rare) or was flipped to 'failed' by the boot-time interrupted-build reset (the common
    // crash/restart case). Requiring anchorCount > 0 distinguishes an interrupted build worth resuming
    // from a systemic-failure row (0 anchors) that should restart clean. Force and hash changes also
    // restart. Stale anchors are cleared AFTER the row is atomically flipped to 'building' below, so a
    // failure can never leave a 'ready' row with zero anchors.
    const resuming = Boolean(
      existing &&
      !force &&
      hashesMatch &&
      existing.samplesDone > 0 &&
      existing.anchorCount > 0 &&
      (existing.status === 'building' || existing.status === 'failed'),
    );
    const resumeFrom = resuming ? existing!.samplesDone : 0;
    // Seed from the anchors actually on disk, not the stored counter: a crash between insertAnchor and
    // its progress checkpoint can leave a persisted anchor the counter never recorded. countAnchors is
    // the ground truth, and per-sample inserts below only increment on a real (non-conflicting) write.
    let anchorCount = resuming ? await this.repo.countAnchors(existing!.id) : 0;

    const startedAt = Date.now();
    this.logger.log(
      `[${BUILD_EVENT}] [start] textBookId=${textBookId} audioBookId=${audioBookId} samplesTotal=${samplesTotal} resumeFrom=${resumeFrom} sampleIntervalSec=${sampleIntervalSec} clipSeconds=${clipSeconds} - build started`,
    );

    let alignmentId: number | null = null;
    try {
      const alignment = await this.repo.upsertAlignment(textBookId, audioBookId, {
        ebookFileId: ebook.id,
        audioContentHash,
        epubContentHash,
        status: 'building',
        sampleIntervalSec,
        clipSeconds,
        whisperModel,
        samplesTotal,
        samplesDone: resumeFrom,
        anchorCount,
        error: null,
      });
      alignmentId = alignment.id;
      if (!resuming) await this.repo.clearAnchors(alignmentId);

      const spines: SpineText[] = await this.epub.extractSpineText(textBookId, ebook.id, user);
      const maxSpineIndex = spines.length - 1;

      const pathByFileId = new Map<number, string>(audioFiles.map((f) => [f.fileId, f.absolutePath]));
      let lastSpineIndex = resuming ? ((await this.repo.getMaxAnchorSpineIndex(alignmentId)) ?? 0) : 0;
      let lastFraction = resuming ? ((await this.repo.getMaxAnchorFraction(alignmentId)) ?? -Infinity) : -Infinity;
      let attempted = 0;
      let transcribeFailures = 0;
      let consecutiveFailures = 0;
      let lastTranscribeError = '';

      for (let i = resumeFrom; i < samplesTotal; i++) {
        const offset = i * sampleIntervalSec;
        if (offset < totalSeconds) {
          attempted++;
          const outcome = await this.sampleAnchor(
            alignmentId,
            timeline,
            pathByFileId,
            spines,
            offset,
            clipSeconds,
            lastSpineIndex,
            lastFraction,
            maxSpineIndex,
          );
          if (outcome.kind === 'anchored') {
            lastSpineIndex = outcome.spineIndex;
            if (outcome.fraction != null) lastFraction = outcome.fraction;
            // A re-processed sample on resume conflicts on (alignmentId, audioSeconds) and inserts
            // nothing, so only a genuinely new anchor advances the count - keeping it equal to the rows.
            if (outcome.inserted) anchorCount++;
            consecutiveFailures = 0;
          } else if (outcome.kind === 'transcribe_failed') {
            transcribeFailures++;
            consecutiveFailures++;
            lastTranscribeError = outcome.message;
            if ((anchorCount === 0 && consecutiveFailures >= EARLY_ABORT_FAILURES) || consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
              const error = `transcription failed on ${consecutiveFailures} consecutive samples (last error: ${lastTranscribeError.slice(0, 200)}) - verify WHISPER_PATH, WHISPER_MODEL, and ffmpeg`;
              await this.repo.setAlignmentStatus(alignmentId, 'failed', { error, samplesDone: i + 1, anchorCount });
              this.logger.error(
                `[${BUILD_EVENT}] [fail] textBookId=${textBookId} audioBookId=${audioBookId} alignmentId=${alignmentId} durationMs=${Date.now() - startedAt} samplesDone=${i + 1} status=failed reason=transcribe_unavailable - ${error}`,
              );
              return;
            }
          } else {
            consecutiveFailures = 0;
          }
        }
        await this.repo.updateAlignmentProgress(alignmentId, { samplesDone: i + 1, anchorCount });
      }

      const durationMs = Date.now() - startedAt;
      if (anchorCount < MIN_ANCHORS) {
        // Every attempted sample failing to transcribe is a systemic whisper/ffmpeg fault, not a book
        // that genuinely cannot be aligned - surface it as `failed` with a cause so it is retryable.
        const systemic = attempted > 0 && transcribeFailures === attempted;
        const status = systemic ? 'failed' : 'unalignable';
        const error = systemic
          ? `all ${attempted} transcription samples failed (last error: ${lastTranscribeError.slice(0, 200)}) - verify WHISPER_PATH, WHISPER_MODEL, and ffmpeg`
          : null;
        await this.repo.setAlignmentStatus(alignmentId, status, { error, samplesDone: samplesTotal, anchorCount });
        this.logger.log(
          `[${BUILD_EVENT}] [end] textBookId=${textBookId} audioBookId=${audioBookId} alignmentId=${alignmentId} durationMs=${durationMs} samplesTotal=${samplesTotal} anchorsFound=${anchorCount} transcribeFailures=${transcribeFailures} status=${status} - too few anchors`,
        );
        return;
      }

      await this.repo.setAlignmentStatus(alignmentId, 'ready', { builtAt: new Date(), samplesDone: samplesTotal, anchorCount, error: null });
      this.logger.log(
        `[${BUILD_EVENT}] [end] textBookId=${textBookId} audioBookId=${audioBookId} alignmentId=${alignmentId} durationMs=${durationMs} samplesTotal=${samplesTotal} anchorsFound=${anchorCount} status=ready - build completed`,
      );
      await this.syncService.reconcilePairOnReady({ textBookId, audioBookId }, user.id);
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const { errorClass, message } = describeError(error);
      if (alignmentId != null) {
        await this.repo.setAlignmentStatus(alignmentId, 'failed', { error: message.slice(0, MAX_ERROR_CHARS) }).catch(() => {});
      }
      this.logger.error(
        `[${BUILD_EVENT}] [fail] textBookId=${textBookId} audioBookId=${audioBookId} samplesTotal=${samplesTotal} anchorsFound=${anchorCount} durationMs=${durationMs} errorClass=${errorClass} error="${sanitizeLogValue(message)}" - build failed`,
      );
      throw error instanceof Error ? error : new Error(message);
    }
  }

  // Transcribes one sample window and, if it matches monotonically, persists an anchor carrying its
  // ebook fraction. Returns why the window was consumed so the caller can tell a systemic transcription
  // fault from a book that simply did not match. A failed transcription of a single clip is logged and
  // reported (not thrown) so it never fails the whole build.
  private async sampleAnchor(
    alignmentId: number,
    timeline: ReturnType<typeof buildAudioTimeline>,
    pathByFileId: Map<number, string>,
    spines: SpineText[],
    offset: number,
    clipSeconds: number,
    lastSpineIndex: number,
    lastFraction: number,
    maxSpineIndex: number,
  ): Promise<SampleOutcome> {
    const { fileId, positionSeconds } = absoluteSecondsToFilePosition(timeline, offset);
    const path = pathByFileId.get(fileId);
    if (!path) {
      this.logger.warn(
        `[${BUILD_EVENT}] skipped=true alignmentId=${alignmentId} offsetSeconds=${offset} reason=no_audio_path - no path for file ${fileId}`,
      );
      return { kind: 'skipped' };
    }

    let transcript: string;
    try {
      transcript = await this.whisper.transcribeWindow(path, positionSeconds, clipSeconds);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `[${BUILD_EVENT}] skipped=true alignmentId=${alignmentId} offsetSeconds=${offset} reason=transcribe_failed error="${sanitizeLogValue(message)}" - clip transcription failed`,
      );
      return { kind: 'transcribe_failed', message };
    }

    const match = matchTranscript(transcript, spines, { spineWindow: { min: lastSpineIndex, max: maxSpineIndex } });
    if (!match || match.spineIndex < lastSpineIndex) return { kind: 'skipped' };

    // Reject an anchor whose ebook fraction would move backward: the resolver interpolates on a
    // fraction axis and a decreasing fraction against increasing audioSeconds inverts the mapping. A
    // null fraction (phrase not locatable) keeps spine-level ordering and is backfilled lazily.
    const fraction = computeAnchorFraction(spines, match.spineIndex, match.phrase);
    if (fraction != null && fraction < lastFraction) return { kind: 'skipped' };

    const inserted = await this.repo.insertAnchor({
      alignmentId,
      audioSeconds: offset,
      spineIndex: match.spineIndex,
      phrase: match.phrase,
      confidence: match.confidence,
      ebookFraction: fraction,
    });
    return { kind: 'anchored', spineIndex: match.spineIndex, fraction, inserted };
  }

  private computeHash(input: unknown): string {
    return createHash('sha256').update(JSON.stringify(input)).digest('hex');
  }
}

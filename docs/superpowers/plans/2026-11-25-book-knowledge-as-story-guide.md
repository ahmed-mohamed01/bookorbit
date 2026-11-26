# Book Knowledge as the story guide: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. (Codex: this header is for Claude sessions, not for you. Implement the task you are given.)

**Goal:** The Story guide card's Build and Update run a Book Knowledge (BK) X-Ray through upstream's AI job engine, and the result is stored in the story guide `ai_artifacts` row that the official iOS app and the Absorb fork route already read.

**Architecture:** A fork `StoryGuidePipeline` with one step (`bk`, slot `fast`) replaces upstream's pipeline through the `STORY_GUIDE_PIPELINE` provider. The step waits for BK's index, then runs a new awaitable BK build whose model calls go through the step's `ctx.complete`. `assemble` turns BK's payload into a valid format 1 payload with `profiles` filled and BK's extra fields kept. Three small upstream hooks: the pipeline provider, the estimate, and a rewrite of BK's extra fields after reader fixes.

**Tech Stack:** NestJS 11, Drizzle/PostgreSQL, Vitest, `@bookorbit/types`.

**Spec:** `docs/superpowers/specs/2026-11-25-book-knowledge-as-story-guide-design.md` (approved 2026-11-25). Read it before your task.

## Global Constraints

- Fork rules (FORK_MAINTENANCE.md): new code in fork-owned files. Upstream files get only the hooks named in this plan, each recorded in FORK_MAINTENANCE.md (overlay section and conflict surface table). Never reformat upstream code; check with `git diff -w upstream/main -- <file>`.
- No schema change. Fork schema never uses Drizzle migrations.
- Logs: `[event] [start|end|fail] key=value ... - message`. The step's event is `story_guide.bk_build`. Use `sanitizeLogValue()` for quoted values.
- Throw NestJS `HttpException` subclasses in HTTP paths. Inside the job, throw `AiJobFailure(reason, message)` or `AiJobPause`, never a raw `Error`.
- The stored payload is `format: 1`, and its `textKey` is the subject's upstream text key, never `bk:...`.
- Multi-user: the job runs as the user who pressed Build. Book access and `Permission.LibraryGenerateStoryGuide` stay upstream's.
- Tests use `.test.ts`, Vitest (`vi.fn`, `vi.mock`), and `Test.createTestingModule` where DI is involved.
- No em dashes anywhere. No `Co-authored-by` lines. No commits unless the user says so: the "Commit" steps below are checkpoints the controller runs only after the user's go-ahead.
- A new `@Inject(DB)` service must be added to the allowlist in `architecture-boundaries.test.ts`.
- Gate before any commit: `NODE_OPTIONS=--max-old-space-size=8192 CI=true pnpm run verify:fast` (run unsandboxed).

## Review Focus

1. **A pause or abort inside BK's many parallel asks.** `ctx.complete` throws `AiJobPause('over-estimate')`, `AiJobPause` (provider down), and the abort when the job is cancelled. BK's per-call handling (`replayable`, `calls.track`, unit "invalid" counting) must not swallow these into an invalid unit. The step must stop and rethrow the original error, so the engine pauses or cancels the job and no row is written. Test owned by Task 2.
2. **Two jobs at once.** The engine runs up to 3 jobs. A second story guide job, or an admin bench run, must wait for BK's single-build slot and not fail with `ConflictException`. A cancelled waiting job leaves the queue. Test owned by Task 2.
3. **The BK index is not ready, or it fails.** The step queues the index and waits. A failed index, BK being off, or a timeout ends the job with a short `AiJobFailure` reason. The engine must not spin or retry forever. Test owned by Task 3.
4. **Reader fixes on a BK guide.** A hide or merge must not leave chronicle or links entries pointing at a removed key. A line edit must show in Absorb's About as well as on iOS. Test owned by Task 4.
5. **The estimate is too low for BK's real cost.** The engine pauses a job whose spend passes the estimate cap. When the index is not ready at estimate time, the estimate must still be a BK-shaped figure, never upstream's lower one, so a normal build does not pause as over-estimate. Test owned by Task 3.

---

### Task 1: BK reads the book's story guide file in any story guide format

BK's index and X-Ray must use the same file upstream's Build uses, so the stored `textKey` and BK's anchors come from one text.

**Files:**
- Modify: `server/src/modules/book-knowledge/book-knowledge.service.ts` (`source`)
- Modify: `server/src/modules/book-knowledge/book-knowledge-xray.service.ts` (`prepare`)
- Modify: `server/src/modules/book-knowledge/core/build-pipeline.ts:63-64`
- Create: `server/src/modules/book-knowledge/core/book-text-stage.ts`
- Modify: `server/src/modules/book/book-read.service.ts` (fork-owned `knowledgeEpubFiles`, beside it)
- Test: `server/src/modules/book-knowledge/core/book-text-stage.test.ts`, `server/src/modules/book-knowledge/book-knowledge.service.test.ts`

**Interfaces:**
- Produces: `BookReadService.knowledgeFile(bookId: number): Promise<{ id: number; format: string; absolutePath: string; fileHash: string | null } | null>`. It returns the file upstream's `storyGuideFiles(files, book.formatPriority, book.primaryFileId)[0]` picks (import `storyGuideFiles` from `story-guides.service.ts`; do not copy it).
- Produces: `BookKnowledgeService.source(bookId)` returns `{ file, fingerprint }` for that file. The fingerprint formula is unchanged. A book with no story guide format file throws `BadRequestException('Book Knowledge requires an EPUB, KEPUB, MOBI, AZW3 or AZW file')`.
- Produces: `extractBookText(path: string, format: string): Promise<TextStage>` in `core/book-text-stage.ts`. For `epub` and `kepub`, it calls the existing `extractEpubText(path)` unchanged. For `mobi`, `azw3` and `azw`, it builds a `TextStage` from upstream's `readBookText(path)`: linear sections only, sentences split the way `epub-text.ts` splits them, `spineBytes` = each section's UTF-8 text length.
- Produces: `BookKnowledgeService.sourceFileId(bookId): Promise<number | null>`, used by Tasks 3 and 5.
- `prepare` uses the same `knowledgeFile`, and passes the file's path to `readEpubMetadata` only for epub and kepub. For other formats, mode comes from the book's metadata subjects, then from `'fiction'`.

- [ ] **Step 1: Write the failing tests**
  - `book-text-stage.test.ts`:
    - `extractBookText delegates epub and kepub to extractEpubText`: mock `./epub-text.js`, then assert it is called once with the path, and that the result is returned as is.
    - `extractBookText builds sentences from readBookText for mobi`: mock `readBookText` to return two linear sections and one non-linear section. Assert that the sentences come from the linear sections only, in order, that ordinals start at 0, and that `spineBytes.length === 2`.
  - `book-knowledge.service.test.ts`:
    - `source picks the file upstream's Build picks`: the book has an EPUB with id 5 and a MOBI with id 6, and `primaryFileId: 6`. Assert `source(bookId).file.id === 6`.
    - `source refuses a book with no story guide format`: the book has only a PDF. Assert it throws `BadRequestException`.
- [ ] **Step 2: Run them and see them fail.** Run: `cd server && CI=true pnpm vitest run src/modules/book-knowledge/core/book-text-stage.test.ts src/modules/book-knowledge/book-knowledge.service.test.ts`. Expected: FAIL (module not found, or the wrong file id).
- [ ] **Step 3: Implement** `knowledgeFile`, `extractBookText`, `source`, `sourceFileId` and the `prepare` change, and switch `build-pipeline.ts` to `extractBookText(path, format)`. `buildArtifact` gains a `format` option. Keep `knowledgeEpubFiles` only if another caller still uses it.
- [ ] **Step 4: Run the same command.** Expected: PASS. Then run all BK tests: `CI=true pnpm vitest run src/modules/book-knowledge`. Expected: PASS.
- [ ] **Step 5: Checkpoint** (commit only on the user's go-ahead).

### Task 2: An awaitable BK build that the job engine drives

**Files:**
- Modify: `server/src/modules/book-knowledge/book-knowledge-xray.service.ts`
- Create: `server/src/modules/book-knowledge/xray/xray-slot.ts` (the single-build queue)
- Modify: `server/src/modules/book-knowledge/book-knowledge.module.ts` (export `BookKnowledgeXrayService` and `BookKnowledgeService` if they are not exported yet)
- Test: `server/src/modules/book-knowledge/xray/xray-slot.test.ts`, `server/src/modules/book-knowledge/book-knowledge-xray.service.test.ts`

**Interfaces:**
- Produces: `class XraySlot { acquire(signal?: AbortSignal): Promise<() => void>; busy(): boolean }`. It is FIFO. An aborted waiter leaves the queue and rejects with the signal's reason. `start` keeps throwing `ConflictException` when `busy()` (the bench route's behaviour does not change). The new entry point waits.
- Produces: `type XrayCompleter = (request: { use: AiModelChoice; system: string; user: string; maxOutputTokens: number; effort?: AiEffort; temperature?: number }) => Promise<AiResult>`.
- Produces: `BookKnowledgeXrayService.buildForStoryGuide(input: { bookId: number; user: RequestUser; complete: XrayCompleter; signal: AbortSignal; use: AiModelChoice }): Promise<BookKnowledgeXrayPayload>`. It is a whole-book, non-dry run. `use` is the job's `fast` model, and it replaces `this.model.choice('fast')`. Every `ask` goes through `complete` instead of `this.model.complete`. It reuses BK's unit cache, and it does not call `persist` (Task 5 removes `persist`). It rejects with the first error that is an `AiJobPause`, an `AiJobFailure`, or an abort, after the in-flight asks have settled. Any other failure rejects with `AiJobFailure('error', <short message>)`.
- Consumes: `AiUnitSkipped` from `ai-jobs/ai-feature.ts`. The step adapter (Task 3) turns it into a result with `finish` set to its reason and empty `text`, so BK counts the unit as skipped exactly as it does today for a refused reply.

- [ ] **Step 1: Write the failing tests**
  - `xray-slot.test.ts`:
    - `second acquire waits for release`.
    - `aborted waiter is removed and the next one runs`.
  - `book-knowledge-xray.service.test.ts`, reusing the file's existing fixtures for a small artifact:
    - `buildForStoryGuide sends every ask through the given completer`: `model.complete` is never called, `complete` is called at least once, and the payload is returned.
    - `buildForStoryGuide rethrows AiJobPause from the completer and writes nothing`: `complete` rejects on the third call with `new AiJobPause('over-estimate')`. Assert the promise rejects with that same instance and that no unit-cache entry is flushed for the failed call.
    - `buildForStoryGuide waits for a running bench build instead of throwing`: `start(...)` is running, a `buildForStoryGuide` call resolves after it ends, and `start` during `buildForStoryGuide` still throws `ConflictException`.
    - `buildForStoryGuide stops on abort`: aborting the signal rejects, and no further `complete` call starts.
- [ ] **Step 2: Run them and see them fail.** Run: `cd server && CI=true pnpm vitest run src/modules/book-knowledge/xray/xray-slot.test.ts src/modules/book-knowledge/book-knowledge-xray.service.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Factor `build`/`steps` so that both `start` and `buildForStoryGuide` share them, with the completer and model choice passed in. Do not fork the step code. The capped asks (`{...fast, maxOutputTokens: limit}`) pass `maxOutputTokens` in the request. The engine replaces `use` with the job's model, so record in a code comment at the adapter that the cap now rides on the request alone.
- [ ] **Step 4: Run the same command, then all BK tests.** Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 3: The fork story guide pipeline, its estimate, and the upstream hooks

**Files:**
- Create: `server/src/modules/fork-story-guide/bk-pipeline/bk-story-guide-pipeline.ts` (factory, step, `assemble`, `render`, `estimate`)
- Create: `server/src/modules/fork-story-guide/bk-pipeline/bk-story-guide-assemble.ts` (pure function)
- Create: `server/src/modules/fork-story-guide/bk-pipeline/bk-story-guide-pipeline.module.ts` (imports `BookKnowledgeModule`; provides and exports `BkStoryGuideRunner`)
- Create: `server/src/modules/fork-story-guide/bk-pipeline/bk-story-guide-runner.service.ts`
- Modify (upstream hook): `server/src/modules/story-guides/story-guides.module.ts:34,47`
- Modify (upstream hook): `server/src/modules/story-guides/pipeline/story-guide-pipeline.ts` (one optional member) and `server/src/modules/story-guides/story-guide.feature.ts:98-100` (one line)
- Test: `bk-story-guide-assemble.test.ts`, `bk-story-guide-pipeline.test.ts`, `bk-story-guide-runner.service.test.ts` beside them

**Interfaces:**
- Hook 1, the pipeline provider: `story-guides.module.ts` imports `BkStoryGuidePipelineModule` and provides `STORY_GUIDE_PIPELINE` with `useFactory: createBkStoryGuidePipeline, inject: [BkStoryGuideRunner, StoryGuideEstimator]`. Upstream's `createStoryGuidePipeline` import stays, so the diff stays small.
- Hook 2, the estimate: `StoryGuidePipeline` gains `estimate?(subject: StoryGuideSubject, reuse: AiEstimateReuse): Promise<AiJobEstimate>`. `StoryGuideFeature.estimate` becomes `return this.parts.estimate ? this.parts.estimate(subject, reuse) : this.estimator.estimate(subject.text, this.stepsToRun(reuse), reuse.models);`
- Produces: `createBkStoryGuidePipeline(runner: BkStoryGuideRunner, estimator: StoryGuideEstimator): StoryGuidePipeline` with:
  - `steps`: one step, `{ id: 'bk', version: BK_PROMPT_VERSION, slot: 'fast', dependsOn: [] }`. `BK_PROMPT_VERSION` is the BK prompt version constant that already exists; if there are several, the builder exports one combined integer from `book-knowledge-prompts.ts`.
  - `units`: `[{ id: 'book' }]`. `fingerprint`: `` `${subject.bookId}:${bkFingerprint}:${BK_PAYLOAD_VERSION}` ``, read through the runner.
  - `run(ctx)`: calls `runner.build(ctx)` and returns the payload.
  - `assembleVersion`: `BK_PAYLOAD_VERSION`, BK's payload format version constant.
  - `assemble(ctx)`: `assembleBkStoryGuide(ctx.results('bk').get('book'), { textKey: ctx.subject.key, pipeline, models: ctx.job.models, coverage: ctx.coverage, builtAt: new Date().toISOString() })`.
  - `render(payload, format)`: the payload when `format === 1`, else `null`.
  - `estimate(subject, reuse)`: `runner.estimate(subject, reuse.models)`.
- Produces: `assembleBkStoryGuide(bk: BookKnowledgeXrayPayload, meta: { textKey: string; pipeline: string; models: AiJobModels; coverage: number; builtAt: string }): StoryGuidePayloadV1 & BkExtras`:
  - `format: 1`, with `textKey`, `pipeline`, `models`, `coverage` and `builtAt` from `meta`.
  - Every entity and join gets `profiles` = its chronicle `about` entries as `{ text, through }`, in order.
  - `chronicle.basis = meta.builtAt`.
  - Every other BK field is kept as is.
- Produces: `BkStoryGuideRunner`:
  - `check(subject): Promise<AiRefusal | null>` returns `{ reason: 'off' }` when BK settings or BK's AI feature row are off.
  - `build(ctx: AiStepContext<StoryGuideSubject>): Promise<BookKnowledgeXrayPayload>`:
    1. `ctx.subject.file.id` must equal `knowledge.sourceFileId(bookId)`. Otherwise it throws `AiJobFailure('unreadable', 'Book Knowledge builds the guide for the book's main ebook file')`.
    2. It ensures the index (below).
    3. It calls `xray.buildForStoryGuide` with `complete` = `ctx.complete` wrapped to map `AiUnitSkipped` (Task 2), `use` = `ctx.job.models.fast`, and `signal` = `ctx.signal`.
    4. It logs `story_guide.bk_build` start, end and fail lines.
  - `estimate(subject, models): Promise<AiJobEstimate>`: when the index is ready, it runs the dry-run plan (`densePlannedCalls` and BK's `estimate`), then prices it with the `fast` slot's prices from `AiSettingsService.slots()`. When the index is not ready, it uses `estimator.estimate(subject.text, ['bk'], models)` scaled by `BK_ESTIMATE_FALLBACK_FACTOR`. The builder sets that factor from the R44 Bob build's dry-run cost divided by upstream's estimate for the same text, rounded up, and puts the two figures in a comment.
  - Index wait: it calls `knowledge.context(bookId, user, 'full', false)`, then polls every 5 s until the row is `ready`. It fails with `AiJobFailure('unreadable', ...)` when the row is `failed`, and with `AiJobFailure('error', 'Book Knowledge index timed out')` after 45 min. It rejects at once on abort.
- `check`: the pipeline cannot reach `StoryGuideFeature.check`, so the BK switch check runs at the top of `runner.build` (an `AiJobFailure('unreadable', 'Book Knowledge is off')`). The card's own "off" comes from the story guide flag as today. Record this as a ruling in the ledger, since the spec asked for an `off` refusal.

- [ ] **Step 1: Write the failing tests**
  - `bk-story-guide-assemble.test.ts`:
    - `sets textKey, pipeline, models, builtAt and format from meta`.
    - `fills profiles from chronicle about, in order, with through`: an entity has two about entries and one join has one. Assert the exact `profiles` arrays.
    - `keeps chronicle, links, importance, count and sub; basis equals builtAt`.
  - `bk-story-guide-pipeline.test.ts`:
    - `one step bk on the fast slot`.
    - `render returns null for format 2`.
    - `pipeline name changes when BK_PAYLOAD_VERSION changes`: use `storyGuidePipelineName`.
  - `bk-story-guide-runner.service.test.ts`:
    - `fails unreadable when the job file is not BK's file`.
    - `waits for a queued index, then builds`: the row goes `queued`, `running`, then `ready` over fake timers.
    - `fails when the index fails`.
    - `fails after the timeout`.
    - `maps AiUnitSkipped to a skipped result`.
    - `estimate uses the dry-run plan when the index is ready`.
    - `estimate is never below upstream's estimate when the index is not ready`.
- [ ] **Step 2: Run them and see them fail.** Run: `cd server && CI=true pnpm vitest run src/modules/fork-story-guide/bk-pipeline`. Expected: FAIL.
- [ ] **Step 3: Implement** the files and both hooks. Watch for a Nest circular import: `StoryGuidesModule` imports `BkStoryGuidePipelineModule`, which imports `BookKnowledgeModule`. `BookKnowledgeModule` must not import `StoryGuidesModule` (Task 5 keeps it that way).
- [ ] **Step 4: Run the tests and the existing story guide suites.** Run: `CI=true pnpm vitest run src/modules/fork-story-guide src/modules/story-guides src/modules/ai-jobs`. Expected: PASS. Upstream story guide tests that build `createStoryGuidePipeline` directly keep passing, because they do not use the module. If a module-level test now needs BK providers, mock `BkStoryGuideRunner` in that test, and say so in the report.
- [ ] **Step 5: Check the hook's size.** Run: `git diff -w upstream/main -- server/src/modules/story-guides | grep '^[+-][^+-]' | wc -l`. Expected: 6 lines or fewer for Task 3's hooks.
- [ ] **Step 6: Checkpoint.**

### Task 4: Reader fixes also rewrite BK's extra fields

**Files:**
- Create: `server/src/modules/fork-story-guide/bk-pipeline/rewrite-bk-extras.ts`
- Modify (upstream hook): `server/src/modules/story-guides/story-guides.service.ts:170` (one line)
- Test: `server/src/modules/fork-story-guide/bk-pipeline/rewrite-bk-extras.test.ts`

**Interfaces:**
- Produces: `rewriteBkExtras<T>(payload: T): T`, a pure function. When the payload has no `chronicle`, it returns the input unchanged. Otherwise it returns a copy where:
  - every chronicle entity whose key is still an entity or join in `entities` has `about` = its `profiles` mapped back to about entries, matched by `through`;
  - chronicle entities, `chronicle.pairs` and `links` that name a key no longer present are dropped.
- Hook: in `content()`, `await this.fixes.apply(...)` becomes `rewriteBkExtras(await this.fixes.apply(...))`.

- [ ] **Step 1: Write the failing tests:**
  - `returns an upstream payload unchanged`.
  - `hide drops the key from chronicle, pairs and links`.
  - `merge keeps the merged key's chronicle under its join`: the source becomes a join with the same key, so its chronicle entry stays.
  - `line edit updates the matching about entry`.
  - `line hide removes the matching about entry`.
- [ ] **Step 2: Run** `cd server && CI=true pnpm vitest run src/modules/fork-story-guide/bk-pipeline/rewrite-bk-extras.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement it and the hook.**
- [ ] **Step 4: Run it, then `src/modules/story-guides`.** Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 5: Serve the row everywhere; retire BK's payload file and the chronicle port

**Files:**
- Move: `server/src/modules/book-knowledge/book-knowledge-xray-reader.controller.ts` to `server/src/modules/fork-story-guide/bk-xray-reader.controller.ts`. Same route path `books/:bookId/knowledge/xray`, registered in `ForkStoryGuideModule`.
- Modify: `book-knowledge-xray.service.ts`: remove `persist`, `storedPayload`, `payloadPath` and `PAYLOAD_FILE`. A bench `start` run keeps its payload in memory (`payload(runId)`) as today.
- Modify: `fork-story-guide-content.controller.ts`: drop `CHRONICLE_SOURCE` and `withChronicle`, and serve `content.body` with upstream's ETag.
- Delete: `fork-story-guide/chronicle-source.ts`. Update `fork-story-guide.module.ts`.
- Tests: `fork-story-guide-content.controller.test.ts` (update), `bk-xray-reader.controller.test.ts` (new)

**Interfaces:**
- The reader controller reads `StoryGuidesService.content(fileId, [1], user)` with `fileId = BookKnowledgeService.sourceFileId(bookId)`.
  - `found` returns the body.
  - `missing`, or no file, returns `NotFoundException('No X-Ray is stored for this book')`.
  - The response shape stays `BookKnowledgeXrayPayload`, so the BK web panel needs no change.

- [ ] **Step 1: Write and update the tests:**
  - `xray reader returns the stored row's body for the book's BK file`.
  - `xray reader 404s when no guide is stored`.
  - In the content controller: `serves the row body with its chronicle and upstream's ETag`.
  - Delete the tests that only covered `withChronicle`.
- [ ] **Step 2: Run** `cd server && CI=true pnpm vitest run src/modules/fork-story-guide src/modules/book-knowledge`. Expected: FAIL first, then PASS after Step 3.
- [ ] **Step 3: Implement.** Grep for any client or server caller of the removed methods: `grep -rn "storedPayload\|CHRONICLE_SOURCE\|xray-payload" server/src client/src`. Expected: no hits outside tests you updated.
- [ ] **Step 4: Run all server tests touched, then the gate.** Run `NODE_OPTIONS=--max-old-space-size=8192 CI=true pnpm run verify:fast`. Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 6: FORK_MAINTENANCE.md and a live check

**Files:**
- Modify: `FORK_MAINTENANCE.md`:
  - the overlay section: BK as the story guide pipeline;
  - the conflict surface table, one row each for:
    - `story-guides.module.ts` (import and provider);
    - `story-guide-pipeline.ts` (optional `estimate`);
    - `story-guide.feature.ts` (estimate line);
    - `story-guides.service.ts` (`rewriteBkExtras` wrap);
  - remove the `CHRONICLE_SOURCE` row.

- [ ] **Step 1: Write the FORK_MAINTENANCE entries.** Measure them with `git diff -w upstream/main --stat`.
- [ ] **Step 2: Live check on the copy DB `bookorbit_constellations`, with the server on port 6266.** The controller runs this, not a subagent. Say why before each DB command.
  1. Press Build on Bob's Story guide card in the web client.
  2. Watch the Jobs page: one unit, cost recorded, then completed.
  3. Read the row with `curl` on the fork route. Check that:
     - `format` is 1;
     - `textKey` does not start with `bk:`;
     - more than half of the entities have non-empty `profiles`;
     - `chronicle.basis === builtAt`.
  4. Open the book in Absorb on the emulator: chronicle, Now and links show.
  5. Make one hide fix and read the route again: the hidden key is gone from `chronicle` and `links`.
- [ ] **Step 3: Independent review** of the whole branch by a fresh reviewer, then the gate again.
- [ ] **Step 4: Checkpoint.** Ask the user before any commit (signed commits pop 1Password).

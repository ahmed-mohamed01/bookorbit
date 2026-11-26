# Book Knowledge as the story guide builder

Status: approved by the user, 2026-11-25. Answers to the open questions are under Decisions.

## Intent

Book Knowledge (BK) is this fork's improved story guide. Today it lives beside upstream's story guides: its own build route (admin bench only), its own stored file, and its own reader route. The user wants one story guide that is BK's:

- The Story guide card's Build and Update buttons build BK.
- The result is stored where upstream stores guides, so the official BookOrbit iOS app, which the user's family uses, gets the improved guide through its normal route.
- Absorb (the user's Android fork) reads the same stored guide through the fork route `GET /api/v1/story-guide-content/files/:fileId`, including the BK-only fields the official app ignores.
- Books with only an old upstream guide keep serving it until they are rebuilt.

## How the two differ today

| | Upstream story guide | BK today |
|---|---|---|
| Payload | `StoryGuidePayloadV1` (packages/types/src/story-guide-payload.ts) | `StoryGuidePayloadV1` plus `links`, `chronicle`, entity `importance`, `count`, `sub`, and anchor `n` |
| Stored | One `ai_artifacts` row, feature `story-guides`, `subject_key` = the book text's `textKey`, gzipped, with sha256, size, coverage, models, cost, job, pipeline and format | `xray-payload.json.gz` on disk beside BK's index, keyed by book and BK fingerprint; payload `textKey` is `bk:...` |
| Built by | The AI job engine (`ai-jobs`): Build and Update on the card, estimate, Jobs page, budget, cost, resume. Steps come from the `STORY_GUIDE_PIPELINE` provider in `story-guides.module.ts` | `BookKnowledgeXrayService.start`, the admin route `book-knowledge/xray/runs`; runs are in memory, one at a time, and use upstream's AI client through BK's own AI feature row |
| Served | `GET mobile/books/files/:fileId/story-guide`, App Attest-gated (production needs a genuine iOS app); ETag; reader fixes applied by entity key | `GET books/:bookId/knowledge/xray`, normal login; the BK web panel reads it |
| Update prompt | "An improved story guide is available" when the row's `pipeline` differs from the feature's | none |

## What the official iOS app will show from a BK guide

It reads format 1 and ignores fields it does not know. BK's R44 Bob build fits that format: quotes are at most 12 words (0 of 1247 over), section hashes match upstream's, and unknown kinds (`idea`) show under Terms.

Shown: names and merges (joins), identity `lines`, ties, chapter `summaries`, kinds.
Not shown: the chronicle (Now, timelines, abilities, pair descriptions), `links`, `importance`, `sub`, sentence numbers.
Gap to close: BK leaves `profiles` empty (0 of 341 entities in R44). The iOS app uses `profiles` for "who the character is and what they have done so far". The stored payload must fill `profiles` from the chronicle (below), or iOS shows less than an upstream guide.

## Goals

1. Build and Update on the Story guide card run a BK build through the AI job engine.
2. The finished build is stored in the story guide `ai_artifacts` row for the book text, readable by upstream's mobile route and the fork route without change to either.
3. The stored payload is valid format 1 for the official app, with `profiles` filled.
4. Absorb shows the full BK guide (chronicle, links) from the fork route.
5. A book with an older upstream guide still serves it, and its card offers Update, which builds BK.

## Non-goals

- Changing the iOS app or upstream's mobile route.
- Showing the chronicle on iOS.
- New model providers: BK keeps the models and connections it is configured with.
- Reworking BK's extraction quality. This is plumbing.

## Anti-goals

- Writing into upstream's tables from outside upstream's engine (a side-channel write that skips cost, jobs and ETag bookkeeping).
- Overwriting a stored guide with a partial or failed BK build.
- A build that silently costs more than its estimate.

## Approaches for the build

A. **One step on the `fast` slot.** The fork pipeline has a single step, slot `fast`. Its run calls a new awaitable BK build for the book and returns the payload; `assemble` adapts it. BK's model calls for this build go through the step's `ctx.complete` (BK's model service takes the completer for the run), so the engine records cost, applies the story guide budget and the over-estimate cap, pauses on provider-down or empty slot, and stores the slot's model in the row. Reuses BK's unit cache and windowing as is. Costs: the Jobs page shows one unit (no per-chapter progress); the engine's per-unit resume is lost (BK's unit cache makes a rerun cheap); the estimate needs BK's dry run (below). A code-only step (`slot: null`) was ruled out: such a step cannot call `ctx.complete` (ai-job-runner.service.ts:250), so the Jobs page would show $0 and no budget would apply.

B. **Native steps.** Port BK's phases (kind review, entities, dense pass, assembly) to `AiStep`s whose units are BK units and whose calls go through `ctx.complete`. Full engine progress, resume, per-step versions and per-slot models. Large port of BK's orchestration (unit window, 8 calls in flight, sequential alias asks), high regression risk on a pipeline that has 40+ benchmark rounds behind it.

C. **Write-through after a bench run.** Keep BK's build where it is and copy finished payloads into the row. Rejected: it is the side-channel write in Anti-goals and gives no Build button.

Recommendation: A now. B only if the single-unit progress or resume proves to matter.

## Design (approach A)

### Pipeline slot

- The fork provides a `StoryGuidePipeline` (`server/src/modules/fork-story-guide/` or a BK-owned folder) with one step, id `bk`, `slot: 'fast'`, version = BK's prompt version, `dependsOn: []`.
- Hook: the `STORY_GUIDE_PIPELINE` provider in `story-guides.module.ts` uses the fork factory instead of `createStoryGuidePipeline`. One-line upstream edit, recorded in FORK_MAINTENANCE.md (surface table and overlay section).
- `assembleVersion` = BK's payload version. The feature's `pipeline` name then changes with BK's prompts, so upstream's "improved guide available" works unchanged, and every upstream-built row reads as outdated.

### The step

- `units`: one unit per job. `fingerprint`: BK's fingerprint for the book plus its prompt version.
- `run`: builds from the job's own file, in any format upstream's story guides accept (BK is changed to read a given file instead of the book's primary EPUB, so the stored row's `textKey` and the anchors come from the same text). It makes sure BK's index for that file exists (queues it if missing and waits, with a timeout of the builder's choosing), runs the whole-book X-Ray (not dry, not `through`) through a new awaitable entry point (today's `start` returns before the build ends and refuses a second build), honours the job's abort signal, and returns the payload. Failures map to `AiJobFailure` with a short reason.
- Which file: BK keeps one index per book, so BK's file becomes the one upstream's Build picks by default (`storyGuideFiles(...)[0]`, story-guides.service.ts:266). A job on another file of the same book fails with a short reason instead of re-indexing the book. (Builder's call, 2026-11-25.)
- BK's single-build guard: the new entry point waits its turn instead of throwing, since the engine runs up to 3 jobs at once (ai-job-worker.service.ts:19).
- Story guide formats upstream accepts are epub, kepub, mobi, azw3 and azw (story-text.types.ts:4). BK builds all of them: the X-Ray already reads text through upstream's `readBookText` (book-knowledge-xray.service.ts:259), and BK's sentence index keeps `core/epub-text.ts` for EPUB and KEPUB (so existing EPUB indexes, unit caches and web-panel positions do not change) and reads MOBI, AZW3 and AZW through `readBookText`. (Builder's call, 2026-11-25.) Fiction or nonfiction mode comes from the EPUB's `dc:subject` when there is one, else the book's metadata subjects, else fiction.
- Switches: the job needs both the story guide feature on (upstream's `check`) and BK on (its settings and its AI feature row); otherwise `check` refuses with `off`.

### Assemble: the stored payload

From BK's payload:
- `textKey` = the subject's upstream `textKey` (not `bk:...`), `pipeline` = the feature's pipeline name, `models` = the job's models, `coverage` = the engine's coverage, `builtAt` = now, `format: 1`.
- `profiles`: for each entity and join, one `StoryGuideLine` per chronicle `about` entry, same text and `through`. This gives iOS a spoiler-cut description per chapter, and a reader fix to a profile maps one to one onto the `about` entry Absorb shows. `now` stays chronicle-only. Keep `lines` as BK made them. (Builder's call, 2026-11-25: `about` only, not `about` plus `now`, so fixes map cleanly.)
- Keep `chronicle` (with `basis` = the new `builtAt`), `links`, `importance`, `count`, `sub`, anchor `n` as extra fields.
- `render(payload, 1)` returns it; any other format returns null.

### Serving

- iOS: unchanged mobile route reads the row.
- Absorb: the fork route already reads the row through `StoryGuidesService.content`, so it serves the BK build with no route change. Drop the fork `CHRONICLE_SOURCE` port and `chronicle-source.ts`: the chronicle now travels inside the payload.
- BK web panel: `GET books/:bookId/knowledge/xray` reads the row for the book's file instead of the file on disk. BK stops writing `xray-payload.json.gz`; existing files are left for cleanup.

### Reader fixes

Upstream applies reader fixes by entity key at serve time, to a copy of the whole payload (apply-fixes.ts:467). BK keys differ from upstream's, so fixes made on an old upstream guide stop matching once the book is rebuilt with BK (they become orphans, which upstream already counts). Fixes made on a BK guide keep working only while BK keeps entity keys stable between rebuilds; the builder confirms BK derives keys the same way on every run. Merge, rename and hide fixes change `entities` but not `chronicle` or `links`, which are keyed by entity key. After upstream applies fixes, the fork rewrites those too. Upstream's merge turns the source into a join of the kept entity with its key unchanged (apply-fixes.ts:315-341), which Absorb already folds; rename and split keep keys. So the rewrite only has to: set each present entry's chronicle `about` from its fixed `profiles` (line edits and line hides), and drop keys no longer in the payload from `chronicle.entities`, `chronicle.pairs` and `links`. One small hook in `StoryGuidesService.content` (or the fixes service) calls the fork rewrite; recorded in FORK_MAINTENANCE.md. Old upstream fixes that no longer match after a BK rebuild become orphans, as upstream already handles.

### Settings, models and budget

The Build button belongs to the story guide feature, so its enabled flag, word limit, `fast` slot model and budget govern the job: BK's calls during the job go through `ctx.complete`, so cost, cap and usage land on the story guide feature. BK's own model settings keep governing its index, term cards and bench runs. The row records the `fast` slot's model, so upstream's "models changed" Update prompt works.

### Estimate

The engine's estimate comes from `StoryGuideEstimator` over the pipeline steps, which knows nothing about BK. The fork needs the feature's estimate for this pipeline to come from BK's dry run (`dryRun: true` already plans and estimates). This is a second hook in upstream code (the estimator or `StoryGuideFeature.estimate`); keep it to one line.

## Constraints

- Fork rules (FORK_MAINTENANCE.md): new code in fork-owned files, upstream gets the smallest hook, record every hook.
- No Drizzle migrations for fork schema (memory); this design needs no schema change.
- Logs follow CLAUDE.md (`[event] [start|end|fail]`), event `story_guide.bk_build`.
- Multi-user: the job runs as the user who pressed Build; book access and `LibraryGenerateStoryGuide` permission are upstream's.

## Left to the builder

- Where the fork pipeline lives (fork-story-guide vs book-knowledge module).
- How the step waits on BK's single-build guard.
- Exact progress reporting, if the engine offers any for a single unit.

## Decisions (user, 2026-11-25)

1. A BK build writes only the story guide row; BK's own payload file is retired and its web panel reads the row.
2. Reader fixes also rewrite the chronicle and links (one extra hook). Old upstream fixes are dropped on rebuild.
3. BK builds every format upstream's story guides accept (EPUB, KEPUB, MOBI, AZW3, AZW); its index reads text through upstream's reader.
4. Approach A: one step on the `fast` slot.

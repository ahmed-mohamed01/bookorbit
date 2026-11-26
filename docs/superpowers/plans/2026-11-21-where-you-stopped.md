# Where You Stopped (Round 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Codex workers: this header is for another agent; you are the implementer of the one task you are given.

**Goal:** A "Story so far" card on Absorb's book page: guide chapter summaries up to the saved ebook position, then upstream's `recap-stop` answer on the text just before it, chosen by the BookOrbit server.

**Architecture:** A fork route in `fork-story-guide/` reads the user's saved CFI through `BookService.getProgress`. It places the CFI in the chapter's collapsed text with upstream's position converter, filters the guide's summaries, cuts the last stretch, and calls the exported `ReadingHelpService.answer` with `recap-stop`. Absorb fetches it with a stored copy and draws the card in its fork-owned book page.

**Tech Stack:** NestJS 11 + Vitest; Flutter/Dart + flutter_test.

**Spec:** `docs/superpowers/specs/2026-11-21-where-you-stopped-design.md`. Builds after `docs/superpowers/plans/2026-11-21-constellations-chronicle.md` (round 2), in the same two worktrees.

## Global Constraints

- No git commits unless the user says so in chat. Each task ends with "stop for review".
- No em dashes anywhere.
- BookOrbit: the only upstream edit is adding `EpubDomService` to `exports` in `server/src/modules/position-converter/position-converter.module.ts`. Record it in FORK_MAINTENANCE.md: the surface table row and the overlay section. Everything else goes in `server/src/modules/fork-story-guide/`. No `@Inject(DB)` in fork code: progress comes from `BookService.getProgress(user.id, fileId, user)`.
- Logs use event `story_guide.recap` and never include book text.
- Stretch limits: start at the current chapter start, extend back while under 2,000 characters, cap at 12,000 (`READING_HELP_MAX_PASSAGE_LENGTH`), and trim from the front to a paragraph or sentence start.
- Absorb follows the fork rules as in round 2. Copy constants: "Story so far", "Previously", "Where you stopped", "Show earlier chapters", "Try again", "Offline", "Chapter N · P%".

## Review Focus

1. A CFI from a different EPUB build: the spine step is past the spine, or the in-chapter path doesn't resolve. Expect `stop.state: 'unplaced'` and no model call. Test in Task 1.
2. A position in the very first chapter, a few hundred characters in. The stretch is just that text, with no earlier chapter and no empty passage, and `previously` is `[]`. Test in Task 1.
3. A summary whose `through` is a quote inside the current chapter, after the offset: it is left out. Test in Task 1.
4. `READING_HELP_OFF` or a budget error: 200 with `previously` and `stop.state` set, never a 4xx. Test in Task 2.
5. The book page opens again without reading: Absorb sends `?stop=0` and keeps the stored answer. Test in Task 3.

---

### Task 1: Recap helpers on the server

**Files:**
- Modify: `server/src/modules/position-converter/position-converter.module.ts` (one export)
- Create: `server/src/modules/fork-story-guide/story-recap.core.ts`
- Test: `server/src/modules/fork-story-guide/story-recap.core.test.ts`

**Interfaces:**
- Consumes: `cfiPointToCollapsedCp`, `parseChapterDocument` (`position-converter.core.ts`); `chapterIndexFromSpineStep` and the CFI parsing in `cfi.utils.ts`; `ChapterDocument.index.collapsed`.
- Produces:
  - `placeCfi(cfi: string, chapter: (i: number) => Promise<ChapterDocument | null>): Promise<{ chapterIndex: number; offset: number | null } | null>`. Returns null when there is no spine step, and `offset: null` when the in-chapter path fails.
  - `visibleSummaries(summaries: StoryGuideLine[], at: { chapterIndex: number; offset: number | null; text: string }, titleOf: (s: number) => string | null): { title: string | null; text: string }[]`
  - `pickStretch(chapters: (i: number) => Promise<string | null>, at: { chapterIndex: number; offset: number }): Promise<string | null>`

- [ ] **Step 1: Write failing tests.** Build chapters from small XHTML strings through `parseChapterDocument`.
  - `placeCfi finds chapter 3 and the offset of a text node point`
  - `placeCfi returns offset null for a path that does not resolve`
  - `placeCfi returns null for a CFI with no spine step`
  - `visibleSummaries keeps end anchors of earlier chapters and drops the current chapter's end anchor`
  - `visibleSummaries keeps a quote anchor before the offset and drops one after it`
  - `pickStretch extends into the previous chapter when the current part is under 2000 chars`
  - `pickStretch caps at 12000 chars and starts at a sentence boundary`
  - `pickStretch in chapter 0 near the start returns just that text`
  - `pickStretch returns null for offset 0 in chapter 0`
- [ ] **Step 2: Run** `cd server && CI=true pnpm vitest run src/modules/fork-story-guide/story-recap.core.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** as pure functions. A quote is visible when `q`, whitespace-collapsed, is found in `text.slice(0, offset)`.
- [ ] **Step 4: Run** the same command. Expect PASS.
- [ ] **Step 5:** Run Prettier and ESLint. Stop for review.

### Task 2: The recap route

**Files:**
- Create: `server/src/modules/fork-story-guide/story-recap.service.ts`
- Create: `server/src/modules/fork-story-guide/fork-story-recap.controller.ts` (or a method on round 1's controller; builder's call)
- Modify: `server/src/modules/fork-story-guide/fork-story-guide.module.ts` (import `BookModule`, `ReadingHelpModule`, `PositionConverterModule`)
- Create: `server/src/modules/fork-story-guide/story-recap.types.ts` (`ForkStoryRecap` exactly as the spec; kept in the fork module, not `packages/types`, since only Absorb reads it)
- Test: `server/src/modules/fork-story-guide/story-recap.service.test.ts`
- Modify: `FORK_MAINTENANCE.md`

**Interfaces:**
- Consumes: Task 1 helpers; `BookService.getProgress`; `StoryGuidesService.content` (for `summaries`, `sections` and `language`); `EpubDomService.getChapter`; `ReadingHelpService.answer`.
- Produces: `GET /api/v1/story-guide-content/files/:fileId/recap?stop=0|1`, `@InteractiveOnly()`, returning `ForkStoryRecap`, 200 for every reading help state.

- [ ] **Step 1: Write failing tests** with mocked services:
  - `no progress row gives no-position`
  - `progress 0 or 100 gives no-position`
  - `stop=0 skips the model and gives skipped`
  - `answers recap-stop with one passage and the guide language`. Assert the `answer` call args: `kind: 'recap-stop'`, `passages.length === 1`, and `language` equals the guide's.
  - `READING_HELP_OFF maps to stop off with code, previously still filled`
  - `READING_HELP_BUDGET maps to budget` and `READING_HELP_READER_CAP maps to cap`
  - `unplaced CFI gives unplaced and never calls answer`
  - `no guide gives previously [] and still answers`
  - `file access denied propagates as 403`
- [ ] **Step 2: Run** `CI=true pnpm vitest run src/modules/fork-story-guide`. Expect FAIL.
- [ ] **Step 3: Implement.**
  - Collect the answer's events until `done`. An `error` event maps to `failed`.
  - Abort the model call when the client hangs up, using the same `reply.raw.on('close')` pattern as upstream's controller.
  - Language falls back from the guide's language, to the first `Accept-Language` tag, to `en`.
  - Log start, end and fail per CLAUDE.md, with fields `fileId userId chapterIndex stretchChars cached stopState durationMs`.
  - Add the FORK_MAINTENANCE.md surface row for the export line, and add the route to the overlay section.
- [ ] **Step 4: Run** `CI=true pnpm vitest run src/modules/fork-story-guide src/architecture-boundaries.test.ts`. Expect PASS.
- [ ] **Step 5:** Run Prettier, ESLint (8 GB heap) and `pnpm run verify:fast` from the repo root. Stop for review.

### Task 3: The card in Absorb

**Files:**
- Create: `lib/services/fork/story_recap.dart` (model, fetch and store)
- Create: `lib/widgets/fork/story_so_far_card.dart`
- Modify: `lib/widgets/fork/book_detail_redesign.dart` (place the card after the About block, around line 426)
- Test: `test/fork/story_recap_test.dart`, `test/fork/story_so_far_card_test.dart`

**Interfaces:**
- Consumes: the BookOrbit API service's authorized GET (as in `bookorbit_story_guide.dart`); the ebook file id (`ebookFile['ino']`); the book's ebook progress and CFI from the library provider.
- Produces:
  - `class StoryRecap { List<({String? title, String text})> previously; StoryRecapStop stop; int? chapterIndex; double? percentage; String? chapterTitle; String forCfi; }`
  - `class StoryRecapStore { Future<StoryRecap?> stored(String serverKey, String fileId); Stream<StoryRecap> watch(api, serverKey, fileId, String currentCfi); }`
  - `StorySoFarCard({required Stream<StoryRecap> recap, required bool offline})`

- [ ] **Step 1: Write failing tests:**
  - `watch emits the stored copy first, then the fetched one`
  - `same CFI as stored sends stop=0 and keeps the stored answer`
  - `moved CFI sends a full request`
  - `offline emits the stored copy only`
  - The card shows "Previously" with the last two summaries and "Show earlier chapters" when there are more.
  - The card hides "Where you stopped" for off, budget, cap and unplaced.
  - The card shows "Try again" for failed and refetches when it is tapped.
  - The card is hidden when there are no summaries and no answer.
- [ ] **Step 2: Run** `flutter test test/fork/story_recap_test.dart test/fork/story_so_far_card_test.dart`. Expect FAIL.
- [ ] **Step 3: Implement** to the spec's layout, styled like the "Your reading" card. Show the card only for a BookOrbit ebook with progress strictly between 0 and 1.
- [ ] **Step 4: Run** `flutter test test/fork/` and `flutter analyze lib/services/fork lib/widgets/fork`. Expect PASS.
- [ ] **Step 5: Live check.**
  - Run against the worktree server on 6262 with the copy DB `bookorbit_constellations`, with reading help turned on in that copy DB. Use a model the user names, or leave it off and check the summaries-only path.
  - Read Bob in Absorb on the emulator to Chapter 14, leave the reader, and open the book page. The card should show Chapters 12 and 13 under "Previously" and a recap of the Chapter 14 pages.
  - Reopen the book page. It should make no second model call: check the server log for `cached` or `skipped`.
  - Save screenshots to the session scratchpad. Update `FORK_NOTES.md`. Stop for review.

# Constellations Round 2 (Chronicle Pages) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Codex workers: this header is for another agent; you are the implementer of the one task you are given.

**Goal:** Serve an optional `chronicle` field on the fork story guide route and show it in Absorb as ranked lists, intro + abilities + per-chapter timeline pages for every entity kind, tie info boxes, and a confirm-then-come-back jump.

**Architecture:** BookOrbit's fork content route asks a fork port (`CHRONICLE_SOURCE`, null by default) for a chronicle and adds it to the guide body only when `version` is 1 and `basis` matches the guide's `builtAt`, folding it into the ETag. Absorb parses `chronicle` beside the guide, cuts it with round 1's anchor rule in pure Dart, and redraws the entity page, list order and tie rows from the cut view. A debug-only file override lets the hand-made Bob chronicle show on the emulator before Book Knowledge produces one.

**Tech Stack:** NestJS 11 + Vitest (BookOrbit server); Flutter/Dart + flutter_test (Absorb).

**Spec:** `docs/superpowers/specs/2026-11-21-constellations-chronicle-design.md` (this worktree). Contract: `/Users/ahmed/Library/Application Support/Claude/side-session-notes/local_b9dacdb0-c9c6-4a95-ab9d-97fe973f7393/constellations-chronicle-contract.md`. Round 1 spec and plan sit beside them. Mockups: https://claude.ai/artifact/27PFxPJuLcmizP4uYB8UBv boards 7 to 10.

## Global Constraints

- No git commits in either repo unless the user says so in chat. Each task ends with "stop for review", not a commit.
- No em dashes in code, comments, strings, docs or messages.
- BookOrbit: `CLAUDE.md` + `FORK_MAINTENANCE.md`; all changes inside `server/src/modules/fork-story-guide/`; no upstream file edits; log format `[event] [phase] key=value - message` with event `story_guide.chronicle`; `sanitizeLogValue()` in quoted fields. Run Prettier and ESLint on touched files (`NODE_OPTIONS=--max-old-space-size=8192` for server ESLint).
- Absorb: `AGENTS.md` + `FORK_NOTES.md`; fork code under `lib/**/fork/`, `test/fork/`; hooks end with `// Fork`; upstream-file growth at most 10 lines per commit; no `.arb` strings (plain constants); list every touched path in `FORK_NOTES.md`; `dart format` fork files only; check `python3 scripts/fork/surface.py`.
- Absorb work continues in `~/Desktop/repos/absorb/.claude/worktrees/constellations` on top of round 1's uncommitted files.
- Contract v1 is fixed: field names, nullability and anchor shapes exactly as the contract note. Unknown fields are ignored; `version != 1` or `basis != builtAt` ignores the whole chronicle; one malformed entry is skipped alone.
- Spoiler rule: every chronicle item passes round 1's `anchorVisible` on its `through`; when unsure, hide.
- Fixtures stay small and hand-made: no full guide payload of a real book in the repo (the 134 KB Bob payload stays in the session scratchpad).
- UI copy (plain constants): "Who they are", "What it is", "Now", "Abilities and stats", "as of Ch N", "new", "Story so far", "In the story", "No significant changes", "You are here", "Ties", "Read in Chapter N", "Go to Chapter N: Title?", "You're in Chapter M at P%. A button will bring you back here.", "Cancel", "Go", "Back to Chapter M · P%", "Main", "Supporting", "Mentioned".

## Review Focus

1. A chronicle whose `basis` is a different `builtAt` (guide rebuilt, chronicle not yet): server leaves it out and Absorb ignores it if one slips through. Tests in Tasks 1 and 2.
2. A name inside a note that belongs to an entity not yet shown, or to a join not yet visible ("Viviane Saint-Lys" before its join): rendered as plain text, never a link. Test in Task 3.
3. Reader mid-chapter on the chapter a timeline entry ends: entry hidden, "You are here" row shows label only. Test in Task 3.
4. Jump confirmed, then the user reads on from the target instead of tapping Back: the cut stays frozen only while the chip shows; dismissing or TOC navigation releases it. Test in Task 6.
5. A guide with no `chronicle` and no `importance`: list, entity and place pages render round 1 data in the new layout with no empty cards. Test in Task 5.

---

### Task 1: BookOrbit route serves `chronicle` when a source has one

**Files:**
- Create: `server/src/modules/fork-story-guide/chronicle.types.ts`
- Create: `server/src/modules/fork-story-guide/chronicle-source.ts`
- Modify: `server/src/modules/fork-story-guide/fork-story-guide-content.controller.ts`
- Modify: `server/src/modules/fork-story-guide/fork-story-guide.module.ts`
- Test: `server/src/modules/fork-story-guide/fork-story-guide-content.controller.test.ts`
- Modify: `FORK_MAINTENANCE.md` (the existing "Story guide content route for Absorb" overlay section)

**Interfaces:**
- Produces: `StoryGuideChronicle` TS type (contract v1 verbatim, anchors as `StoryGuideAnchor & { n?: number }`); `CHRONICLE_SOURCE` symbol; `interface ChronicleSource { find(textKey: string, user: RequestUser): Promise<unknown | null> }`; default provider `nullChronicleSource` returning null.
- Consumes: `StoryGuidesService.content()` (round 1). The guide body's `textKey` and `builtAt` are read from the 200 body.

- [ ] **Step 1: Write failing tests** in the controller test, with a stub source:
  - `serves upstream body and etag unchanged when the source returns null` (`body` deep-equals upstream's, `ETag` header equals upstream's).
  - `adds chronicle and a combined etag when version 1 and basis match` (`body.chronicle` equals the source's object; `ETag` differs from upstream's and is stable across two calls).
  - `answers 304 when if-none-match equals the combined etag` (call `content()` with no If-None-Match so the body is available, then compare the combined tag).
  - `leaves chronicle out for a stale basis` and `leaves chronicle out for version 2`.
  - `logs and serves the guide when the source throws` (spy on Logger.warn; message contains `[story_guide.chronicle] [fail]`).
- [ ] **Step 2: Run** `cd server && CI=true pnpm vitest run src/modules/fork-story-guide` and expect the new tests to fail.
- [ ] **Step 3: Implement.** The controller injects `@Inject(CHRONICLE_SOURCE) source`. Combined ETag: `W/"<upstream etag inner>-<first 12 hex of sha256(JSON.stringify(chronicle))>"`, keeping upstream's weak or strong prefix. Call `content()` without `ifNoneMatch`, then compare `If-None-Match` in the controller against the ETag being served (combined, or upstream's when there is no chronicle), the same way upstream's `content()` compares (read it and reuse its helper if exported). With a null source the responses (status, body, ETag, headers) match round 1's. The module provides `{ provide: CHRONICLE_SOURCE, useValue: nullChronicleSource }` and exports the token so Book Knowledge can override it later.
- [ ] **Step 4: Run** the same command and expect a pass. Then run `CI=true pnpm vitest run src/architecture-boundaries.test.ts` and expect a pass (no new `@Inject(DB)`).
- [ ] **Step 5:** Prettier and ESLint on the touched files. Add to the FORK_MAINTENANCE.md overlay: the port, its default, the basis rule and the ETag rule. Stop for review.

### Task 2: Absorb parses `chronicle` and the Bob fixtures

**Files:**
- Create: `lib/services/fork/story_guide_chronicle.dart`
- Modify: `lib/services/fork/story_guide_model.dart` (a `chronicle` field on `StoryGuide`, plus `importance` on `GuideEntity`, `builtAt` on `StoryGuide`)
- Create: `test/fork/fixtures/bob_guide.json` (hand-trimmed from the scratchpad payload: sections 0 to 34 with titles; entities `viv` with joins `viviane-saintlys` and `viviane`, `solfis`, `arthur`, `cernit`, `benetti`, `jor`, `mouq`, `emeric`, a place `fort-stone`, a place `mali`; their ties; summaries through Ch 14; quotes at most 12 words; under 20 KB)
- Create: `test/fork/fixtures/bob_chronicle.json` (contract v1, `basis` = the fixture's `builtAt`; the board 8 and 10 text for Viv, Solfis, Arthur, Cernit and Fort Stone; Viv's Ch 6 note `null`; Viv abilities in three snapshots ending with the board's list, "double cast" `since` in the Ch 14 unit; pairs `solfis|viv` and `arthur|viv`; `joins.viviane-saintlys` at section 5's quote "Viviane")
- Test: `test/fork/story_guide_chronicle_test.dart`

**Interfaces:**
- Produces:
  - `class GuideChronicle { Map<String, ChronicleEntity> entities; Map<String, List<GuideLine>> pairs; Map<String, GuideAnchor> joins; static GuideChronicle? fromJson(Object? json, {required String builtAt}); }`
  - `class ChronicleEntity { List<GuideLine> about; List<ChronicleEntry> timeline; List<AbilitiesSnapshot> abilities; }`
  - `class ChronicleEntry { GuideAnchor through; String? chapter; String? note; GuideAnchor at; }`
  - `class AbilitiesSnapshot { GuideAnchor through; List<AbilityItem> items; }`
  - `class AbilityItem { String group; String name; String? detail; GuideAnchor since; }`
  - `StoryGuide.chronicle` (`GuideChronicle?`), `GuideEntity.importance` (`int?`, kept only for 1, 2 or 3), `StoryGuide.builtAt` (`String`).
- Anchors are parsed with the existing `GuideAnchor.fromJson`; `n` is ignored.

- [ ] **Step 1: Write failing tests:**
  - `parses the Bob chronicle` (Viv has 3 `about`, 12 timeline entries, Ch 6 `note == null`, 3 snapshots).
  - `ignores chronicle with version 2`; `ignores chronicle whose basis is not builtAt`.
  - `skips one malformed timeline entry and keeps the rest` (entry with no `at`).
  - `unknown ability group is kept as other`.
  - `guide without chronicle parses as before` (round 1 fixture `story_guide_payload.json` still gives identical entity and tie counts).
- [ ] **Step 2: Run** `flutter test test/fork/story_guide_chronicle_test.dart` and expect a fail.
- [ ] **Step 3: Implement** with the same lenient `_list` pattern as `story_guide_model.dart`. An entry dropped for a missing or `guideNever` `through`/`at` is skipped on its own.
- [ ] **Step 4: Run** `flutter test test/fork/` and expect all to pass.
- [ ] **Step 5:** Update `FORK_NOTES.md` paths, run `dart format` on the new files. Stop for review.

### Task 3: Cut the chronicle

**Files:**
- Create: `lib/services/fork/chronicle_cut.dart`
- Modify: `lib/services/fork/story_guide_cut.dart` (honour `chronicle.joins`: a join merges from the earlier of its `at` and the chronicle's anchor)
- Test: `test/fork/chronicle_cut_test.dart`

**Interfaces:**
- Consumes: `anchorVisible`, `ReaderCut`, `GuideView`, `GuideView.byKey`, `cutGuide` (round 1).
- Produces:
  - `class ChronicleView { String? about; String? now; AbilitiesSnapshot? abilities; Set<String> newAbilities; List<ChronicleEntry> timeline; Map<String, String> pairText; }` (pairText keyed by the other entity's shown key)
  - `Map<String, ChronicleView> cutChronicle(StoryGuide g, GuideView view, ReaderCut cut)` (entries only for shown entities; join entries fold into their entity once the join is visible)
  - `List<TextSpanPart> linkNames(String text, GuideView view)` where `typedef TextSpanPart = ({String text, String? key})`, matching visible names longest first on word boundaries.
  - `int? currentUnitS(StoryGuide g, ReaderCut cut)` for "You are here".

- [ ] **Step 1: Write failing tests** against the Bob fixtures:
  - `at Ch 14 mid-chapter Viv shows 11 timeline entries and not the Ch 14 one`.
  - `at the end of Ch 14 Viv shows 12 entries and double cast is new`.
  - `null note survives as a no-change entry`.
  - `Viviane Saint-Lys joins Viv from section 5 when chronicle.joins says so` and `without chronicle the join stays at section 13`.
  - `linkNames leaves Viviane Saint-Lys plain before its join and links Solfis after he is named`.
  - `pair text shows on Viv's Solfis row only once the pair's through is visible and a tie is shown`.
  - `about falls back to newest visible identity line when there is no chronicle`.
  - `a pair description stored under viviane-saintlys shows on Viv's page once the join is visible`.
- [ ] **Step 2: Run** `flutter test test/fork/chronicle_cut_test.dart` and expect a fail.
- [ ] **Step 3: Implement.** Compute once per cut change, alongside `cutGuide`, and cache the result in `ConstellationsSession` with the `GuideView`. Keys are resolved through the same join map `cutGuide` builds.
- [ ] **Step 4: Run** `flutter test test/fork/` and expect a pass; round 1's cut tests stay green.
- [ ] **Step 5:** Update `FORK_NOTES.md`. Stop for review.

### Task 4: Ranked lists (board 7)

**Files:**
- Modify: `lib/widgets/fork/constellations_list.dart`
- Create: `lib/services/fork/guide_rank.dart`
- Test: `test/fork/guide_rank_test.dart`

**Interfaces:**
- Produces: `enum GuideRank { main, supporting, mentioned }`; `List<(GuideRank, List<GuideEntityView>)> rankPeople(List<GuideEntityView> people, Map<String, ChronicleView> chronicle, Map<String, List<GuideTieView>> ties)`; `List<GuideEntityView> orderByWeight(...)` for the Places and Terms tabs (no groups).

- [ ] **Step 1: Write failing tests:**
  - `uses importance when present` (1 is main, 2 supporting, 3 mentioned).
  - `Bob at end of Ch 14 without importance groups Viv Solfis Arthur Cernit as main`.
  - `no chronicle and no importance ranks by visible tie count`.
- [ ] **Step 2: Run** and expect a fail.
- [ ] **Step 3: Implement.** Weight is visible timeline entries, ties as tiebreak. Without `importance`, "main" is a weight of at least 25% of the visible chapter units, "mentioned" is one entry or fewer, and the rest are supporting (tune the thresholds so the Bob test passes). The People tab shows section headers MAIN / SUPPORTING / MENTIONED and the entity's `about` (or identity line) as the row subtitle.
- [ ] **Step 4: Run** `flutter test test/fork/` and expect a pass.
- [ ] **Step 5:** Update `FORK_NOTES.md`. Stop for review.

### Task 5: Entity pages (boards 8 and 10)

**Files:**
- Modify: `lib/widgets/fork/constellations_entity.dart` (replace the "So far" / "Earlier" card)
- Create: `lib/widgets/fork/constellations_timeline.dart`, `lib/widgets/fork/constellations_abilities.dart`, `lib/widgets/fork/constellations_ties.dart`
- Test: `test/fork/constellations_entity_test.dart` (extend)

**Interfaces:**
- Consumes: `ChronicleView`, `linkNames`, `currentUnitS`, `GuideRank`.
- Produces: `ConstellationsEntityPage` gains `ChronicleView? chronicle`, `GuideRank? rank` and `void Function(GuideAnchor at, String? title) onAskJump` (replaces the direct `onJump` from timeline and ties; Task 6 wires the dialog).

- [ ] **Step 1: Write failing widget tests:**
  - `character page shows Who they are, Now, Abilities and stats, Story so far, Ties in that order`.
  - `place page shows What it is and In the story without abilities`.
  - `null note row reads No significant changes`.
  - `tapping a tie row opens its info box with Read in Chapter 3`.
  - `tapping a linked name opens that entity page`.
  - `no chronicle shows the identity line as intro and hides the timeline and abilities cards`.
- [ ] **Step 2: Run** and expect a fail.
- [ ] **Step 3: Implement** to boards 8 and 10:
  - Header "Character · Main" and other names.
  - Intro card with a "Now" line (the newest identity line, shown only when it differs from the intro).
  - Abilities card with rows by group in the order Path/Class/Level, Spells, Skills, Traits/Stats, Gear, Other, a "new" chip, and "as of Ch N".
  - Timeline rows: chapter label column, note with name links, jump icon; the current unit's label is accent-coloured and followed by "You are here".
  - Tie rows: initials avatar, linked name, the tie labels in plain words; one expands at a time into an info box with pairText (if any) and "Read in Chapter N" (the first visible quote).
  - Round 1's family block stays above Ties.
- [ ] **Step 4: Run** `flutter test test/fork/` and expect a pass.
- [ ] **Step 5:** Update `FORK_NOTES.md`. Stop for review.

### Task 6: Jump confirmation and the way back (board 9)

**Files:**
- Create: `lib/widgets/fork/constellations_jump.dart` (the dialog and the back chip widget)
- Modify: `lib/widgets/fork/ebook_reader_constellations.dart` (ask, jump, hold `backCfi` + label, freeze the cut)
- Modify: `lib/widgets/fork/constellations_session.dart` (`freeze()` / `release()`: while frozen, `relocated()` does not move the cut)
- Modify: `lib/widgets/ebook_reader_view.dart` (one hook line in the reader stack for the chip, and one in the TOC navigation path that releases it; both end with `// Fork`)
- Test: `test/fork/constellations_jump_test.dart`

**Interfaces:**
- Consumes: `onAskJump` (Task 5), `_jumpToFindHit` (records the history spot already), `_progress`, `GuideSection.title`.
- Produces: `Future<bool> confirmJump(BuildContext, {required String title, required String quote, required String from})`; `ConstellationsBackChip({required String label, required VoidCallback onBack, required VoidCallback onClose})`.

- [ ] **Step 1: Write failing tests:**
  - `dialog shows Go to Chapter 3: Harrak?, the quote and the from line; Cancel returns false`.
  - `session frozen ignores relocations until release`.
  - `back chip calls onBack and then hides`.
  - `close on the chip releases the freeze`.
- [ ] **Step 2: Run** and expect a fail.
- [ ] **Step 3: Implement.** Before jumping, read `rendition.currentLocation().start.cfi` and the label ("Chapter M · P%"), then `freeze()`, then jump. A `{s, end}` target jumps to the next section's start (the spine href); a quote target uses round 1's `_jumpToFindHit`. Back displays the stored CFI, then `release()`. Close and TOC navigation call `release()`. The chip floats top centre over the reader like the board.
- [ ] **Step 4: Run** `flutter test test/fork/` and `python3 scripts/fork/surface.py`; expect a pass and at most 10 new upstream lines across round 1 plus round 2 hooks in `ebook_reader_view.dart` (otherwise prepare a `Fork-Surface:` line for the user's commit).
- [ ] **Step 5:** Update `FORK_NOTES.md`. Stop for review.

### Task 7: Debug override and live check on the emulator

**Files:**
- Modify: `lib/services/fork/story_guide_store.dart` (in `kDebugMode` only: if `<app documents>/constellations/chronicle-<fileId>.json` exists, put its object in the payload's `chronicle` before parsing)
- Test: `test/fork/story_guide_store_test.dart` (extend)

- [ ] **Step 1: Write failing tests:**
  - `debug override adds the chronicle from the documents file`.
  - `override ignored when the file is absent`.
- [ ] **Step 2: Run** and expect a fail. **Step 3: Implement.** **Step 4: Run** `flutter test test/fork/` and `flutter analyze lib/services/fork lib/widgets/fork`; expect a pass.
- [ ] **Step 5: Live check.** Build the dev APK, install it on `absorb_pixel9pro` against the worktree server on 6262 (copy DB `bookorbit_constellations`), and push `bob_chronicle.json` into `files/constellations/chronicle-3043.json` with `adb shell run-as com.barnabas.absorb.dev`. Its `basis` must be set to the copy DB guide's real `builtAt` first. Check at Ch 14 56%:
  - the list grouping;
  - Viv's page;
  - Fort Stone;
  - a tie info box;
  - jump, Back, and close;
  - no Viviane Saint-Lys row.

  Screenshot each into the session scratchpad. Then check the server route with curl: the guide is served without `chronicle` (null source) and the ETag is unchanged from round 1. Stop for review.

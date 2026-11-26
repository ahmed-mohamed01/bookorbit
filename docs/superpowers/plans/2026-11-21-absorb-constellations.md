# Constellations in Absorb Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Codex workers: this header is for another agent; you are the implementer of the one task you are given.

**Goal:** Show BookOrbit story guides as "Constellations" in Absorb's ebook reader, cut at the reader's position, with lists, a character page, chapter summaries and a Sky graph.

**Architecture:** BookOrbit gets one fork-owned read route that reuses upstream's `StoryGuidesService.content()` without App Attest. Absorb fetches and caches the payload per file, computes the reader's cut inside the reader webview with the same raw-text rules the server uses, filters the guide in pure Dart, and draws a reader sheet built from fork-owned widgets reached by small hooks.

**Tech Stack:** NestJS 11 + Vitest (BookOrbit server); Flutter/Dart + flutter_test, foliate in `flutter_epub_viewer` webview JS (Absorb).

**Spec:** `docs/superpowers/specs/2026-11-21-absorb-constellations-design.md` (this worktree). Mockups: https://claude.ai/artifact/27PFxPJuLcmizP4uYB8UBv

## Global Constraints

- No git commits in either repo unless the user says so in chat. Each task ends with "stop for review", not a commit.
- No em dashes in code, comments, strings, docs or messages.
- BookOrbit: follow `CLAUDE.md` and `FORK_MAINTENANCE.md`; new code in fork-owned files; record overlay + surface in `FORK_MAINTENANCE.md`; logging format `[event] [phase] key=value - message`; `sanitizeLogValue()` in quoted log fields.
- Absorb: follow `~/Desktop/repos/absorb/AGENTS.md` and `FORK_NOTES.md`; fork code under `lib/**/fork/`, `test/fork/`, `packages/**/fork/`; hooks end with `// Fork`; at most 10 changed lines per upstream file; no `.arb` strings (plain constants); every touched path listed in `FORK_NOTES.md`; `dart format` fork files only; check `python3 scripts/fork/surface.py`.
- Absorb work happens in a new worktree cut from `fork`: `git -C ~/Desktop/repos/absorb worktree add .claude/worktrees/constellations -b claude/constellations fork` (the main checkout has unrelated uncommitted work on `autoscroll-follow`).
- Spoiler rule (spec, "The cut"): never show anything anchored after the cut; when unsure, hide.
- Scale: guides may hold hundreds of entities and thousands of quotes; filter once per cut change, never per frame; Sky capped at 80 nodes.

## Review Focus

1. Section text that does not match the guide's `chars`/`h` (different EPUB build): every anchor in the current section must be placed by quote or hidden, never compared by `o`. Test in Task 3.
2. Reader on a section the guide does not know (`s` beyond `sections.length`, front matter, a cover image page): cut falls back to whole sections, no crash. Test in Task 3.
3. Server returns 304 with an empty body, or 404 after a guide was deleted: 304 keeps the cache, 404 drops it and the button hides. Test in Task 4.
4. Payload with unknown entity kinds, unknown tie types, missing `profiles`/`summaries`, or `links` absent: parse without error, unknown kinds under Terms, unknown ties by `label`. Test in Task 2.
5. A tie whose other end is not yet shown (named later than the tie's first quote): tie hidden until both ends are shown. Test in Task 2.

---

### Task 1: BookOrbit fork route for guide content

Repo: BookOrbit worktree `/Users/ahmed/Desktop/repos/bookorbit/.claude/worktrees/recursing-williamson-065bbf` (branch off `monitored` when building).

**Files:**
- Create: `server/src/modules/fork-story-guide/fork-story-guide.module.ts`
- Create: `server/src/modules/fork-story-guide/fork-story-guide-content.controller.ts`
- Test: `server/src/modules/fork-story-guide/fork-story-guide-content.controller.test.ts`
- Modify: `server/src/app.module.ts` (import + register `ForkStoryGuideModule`, 2 lines)
- Modify: `FORK_MAINTENANCE.md` (overlay section + conflict surface row for `app.module.ts`)

**Interfaces:**
- Consumes: `StoryGuidesModule` (exports `StoryGuidesService`), `StoryGuidesService.content(fileId: number, formats: readonly number[], user: RequestUser, ifNoneMatch?: string): Promise<StoryGuideContent>`, `StoryGuideContentQueryDto` (`server/src/modules/story-guides/dto/story-guide.dto.ts`), `apiKeyCredentialOf` (`server/src/common/types/request-user.ts`).
- Produces: `GET /api/v1/story-guide-content/files/:fileId?format=1` with upstream's responses: `200` body + `ETag` + `Cache-Control: private, no-cache`; `304` on matching `If-None-Match`; `404 { reason }`; `403 { errorCode: 'API_KEY_ROUTE_FORBIDDEN' }` for API keys.

- [ ] **Step 1: Write the failing tests** in the test file with `Test.createTestingModule()` and a `vi.fn()` service mock. Cases: `found` sends body with `ETag` header and `Cache-Control: private, no-cache`; `not-modified` sends 304 and the ETag; `missing` with reason `none` sends 404 `{ reason: 'none' }`; formats `'1,2'` reach the service as `[1, 2]`, absent format as `[1]`; an API-key user throws `ForbiddenException` with `errorCode: 'API_KEY_ROUTE_FORBIDDEN'` and the service is never called; a `NotFoundException` / `ForbiddenException` from the service propagates.
- [ ] **Step 2: Run** `cd server && npx vitest run src/modules/fork-story-guide` and expect FAIL (module missing).
- [ ] **Step 3: Implement** `ForkStoryGuideContentController` at `@Controller('story-guide-content/files/:fileId')` with `@Get() read(...)` mirroring `server/src/modules/story-guides/story-guide-content.controller.ts` but without `@RequireAppAttest`, and with the API-key refusal first. `ForkStoryGuideModule` imports `StoryGuidesModule`. No logs (hot read path).
- [ ] **Step 4: Run** the test again and expect PASS; then `pnpm run verify:fast` from the repo root (sandbox off, `CI=true`, `NODE_OPTIONS=--max-old-space-size=8192`) and expect PASS.
- [ ] **Step 5: Live check** against the dev server with a throwaway user's login token: `curl -i -H "Authorization: Bearer <token>" http://localhost:6262/api/v1/story-guide-content/files/<fileId>` returns 200 with JSON for a file that has a guide, then 304 with `If-None-Match` set to the returned ETag.
- [ ] **Step 6: Stop for review.**

### Task 2: Absorb guide model and cut filter (pure Dart)

**Files:**
- Create: `lib/services/fork/story_guide_model.dart`
- Create: `lib/services/fork/story_guide_cut.dart`
- Create: `lib/services/fork/story_guide_tie_types.dart` (copy of upstream registry: groups in order, type to group, symmetric flag; from `server/src/modules/story-guides/test-fixtures/tie-types.json`)
- Test: `test/fork/story_guide_cut_test.dart`
- Test fixture: `test/fork/fixtures/story_guide_payload.json` (copy of BookOrbit `server/src/modules/story-guides/test-fixtures/story-guide-payload.json`) plus a small hand-written `test/fork/fixtures/story_guide_edge.json` for the edge cases below.

**Interfaces:**
- Produces:
  - `sealed class GuideAnchor` with `GuideQuote(int s, int o, String q)` and `GuideSectionEnd(int s)`; `StoryGuide.fromJson(Map<String, dynamic>)` with `entities`, `ties`, `summaries`, `sections`, `links` (empty when absent), `fixesRevision`.
  - `GuideEntity { key, name, kind, names, joins, lines, profiles }`, `GuideTie { key, a, type, b, label, at, quotes, count }`, `GuideLine { through, text }`, `GuideSection { s, title, chars, h }`, `GuideLink { a, b, score, count, at }`.
  - `enum GuideTab { people, places, terms }` and `GuideTab tabOf(String kind)` (character to people, place to places, everything else including unknown to terms).
  - `typedef ReaderCut = ({int s, int? o, Set<String> placedQuotes})`: `o` null means whole-section cut; `placedQuotes` holds `q` strings found at or before the page end in a section whose text did not match.
  - `bool anchorVisible(GuideAnchor a, ReaderCut cut, {required bool sectionMatches})`.
  - `GuideView cutGuide(StoryGuide g, ReaderCut cut, {required bool sectionMatches})` returning `GuideView { entitiesByTab, tiesByEntity, linksByEntity, summaries, inThisSection, newInThisSection }` where each entity view carries `shownNames`, `latestLine`, `earlierLines` (profiles preferred over lines when present), and each tie view carries `visibleQuotes`.

- [ ] **Step 1: Write the failing tests** (`flutter test test/fork/story_guide_cut_test.dart`):
  - `anchorVisible`: `{s:3,o:10}` visible at cut `(s:4,o:null)`; at cut `(s:3,o:10)` visible, `(s:3,o:9)` hidden; `GuideSectionEnd(3)` hidden at `(s:3,o:999999)`, visible at `(s:4,o:0)`; at `(s:3,o:null)` every `s:3` quote is hidden.
  - Not-matching section: at `(s:3,o:50,placedQuotes:{'He drew the knife'})` with `sectionMatches:false`, anchor `{s:3,o:5,q:'He drew the knife'}` visible and `{s:3,o:1,q:'Other words'}` hidden even though its `o` is smaller.
  - Entity hidden before its first name's `at`; second name hidden before its own `at`.
  - A join is its own entity before `join.at` and merged after.
  - Tie hidden while one end is hidden, even when the tie's `at` is visible; `visibleQuotes` drops later quotes; count equals visible quotes.
  - Lines: newest visible `through` is `latestLine`, older ones in `earlierLines`, later ones absent.
  - Parsing: unknown kind `'vehicle'` lands in terms; unknown tie type keeps `label`; payload without `profiles`, `summaries`, `links` parses.
  - The real fixture parses and `cutGuide` at the last section shows every entity.
- [ ] **Step 2: Run and expect FAIL.**
- [ ] **Step 3: Implement** the three files. Index anchors once per guide load (entity first-seen, tie first-seen) so `cutGuide` is linear in guide size.
- [ ] **Step 4: Run and expect PASS.** `dart format` the new files; `flutter analyze lib/services/fork test/fork` clean.
- [ ] **Step 5: Stop for review.**

### Task 3: Reader cut from the webview

Revised after a Fable review: Absorb's reader is epub.js (futurepress, `dist/epub.js` under `packages/flutter_epub_viewer/lib/assets/webpage/`), not foliate. The reader widget is `lib/widgets/ebook_reader_view.dart`.

**Files:**
- Create: `packages/flutter_epub_viewer/lib/assets/webpage/html/fork/story-cut.js`
- Modify: the HTML that loads the other fork scripts (where `fork/reader-hooks.js` is included) to load `fork/story-cut.js` (1 line, marked as fork per the existing pattern)
- Create: `lib/widgets/fork/story_cut_bridge.dart`
- Test: `test/fork/story_cut_bridge_test.dart`

**Interfaces:**
- Consumes: `StoryGuide`, `GuideSection`, `GuideQuote`, `ReaderCut` (Task 2).
- Produces:
  - JS `window.forkStorySectionText(index)` (async): loads spine item `index` from the SOURCE parse, `book.spine.get(index).load(book.load.bind(book))` (XML parse, the same kind the server does), and returns `{ index, chars, flat }`: `chars` = length of the raw text, `flat` = flattened text. Raw text follows `rawSectionText` in BookOrbit `server/src/modules/story-guides/text/section-text.ts` exactly (text nodes under `body`, else `html`, skipping any inside `script, style`, concatenated); flattening follows `flattenSectionText` (whitespace runs to one space, remove U+200B U+00AD U+2060 U+FEFF, trim). Must call `section.unload()` after.
  - JS `window.forkStoryPageEnd(quotesJson)` returning `{ index, liveChars, o, placed }` for `rendition` (never `blindRendition`): `index = rendition.location.end.index`; the contents entry from `rendition.getContents()` whose `sectionIndex === index` (never `[0]`: scrolled mode pre-renders); `range = contents.range(rendition.location.end.cfi)`; `o` = raw-text offset of `range.endContainer`/`endOffset`, walking live text nodes with the same skip rule and summing lengths live (read-along wraps text with `splitText` + spans; never cache a node map). An element container is resolved by child position. Reuse the walker pattern at `ebook_reader_view.dart` around lines 5085 to 5120 by copying it into the fork JS, with the script/style skip added. `liveChars` = total live raw length. `placed`: for each `{q, o}` in `quotesJson`, find the occurrence of `q` in the live raw text nearest to its hint `o`; it is placed when that occurrence ends at or before the page-end offset. Returns `{ index, o: null }` on any failure.
  - Dart `class StoryCutBridge { StoryCutBridge(InAppWebViewController wc, StoryGuide guide); Future<ReaderCut?> cut(); }`: per spine index, caches `(chars, h)` where `h` = first 8 hex of SHA-256 of `flat`, computed in Dart with package `crypto` (do not rely on `crypto.subtle`).
  - Dart `int? guideSectionFor(int spineIndex, String h, List<GuideSection> sections)`: `spineIndex` when `sections[spineIndex].h == h`; else the index of the nearest section within plus or minus 2 whose `h` equals (covers manifests that drop itemrefs); else null.
  - Dart `bool sectionMatches(GuideSection? section, {required String h, required int sourceChars, required int liveChars})`: true when `h` equals and `sourceChars == liveChars == section.chars`. When `h` equals but lengths differ, the section counts as not matching (quote path).
  - Cut rules: mapped section and match: `(s: mapped, o: o)`; mapped and no match: `(s: mapped, o: 0, placedQuotes: placed)` with `sectionMatches: false`; not mapped or failure: `(s: last mapped section before, o: null)`, that is whole sections only.
- [ ] **Step 1: Write the failing Dart tests**: `guideSectionFor` exact, shifted by one, not found; `sectionMatches` true, h-equal-but-length-differs false, h differs false; `cut()` with a fake JS evaluator: match case, quote case, failure case falls back to whole sections, a guide with fewer sections than the spine.
- [ ] **Step 2: Run and expect FAIL.**
- [ ] **Step 3: Implement** the JS and the bridge. Call `cut()` after relocate, debounced 300 ms, never per frame; section text cached per spine index for the session.
- [ ] **Step 4: Run tests and expect PASS.** Then on the simulator, with several real EPUBs that have guides (not only the fixture), log per section: spine index, mapped `s`, `h` equal, source vs live vs guide `chars`. Report the match rate; this decides whether the quote path is the common one.
- [ ] **Step 5: Stop for review.**

### Task 4: Fetch and cache the guide

**Files:**
- Create: `lib/services/fork/bookorbit_story_guide.dart` (`part of '../api_service.dart'`)
- Modify: `lib/services/api_service.dart` (one `part` line, `// Fork`)
- Create: `lib/services/fork/story_guide_store.dart`
- Test: `test/fork/story_guide_store_test.dart`

**Interfaces:**
- Consumes: `StoryGuide.fromJson` (Task 2); the service's authenticated request path (reuse what `_boGet` uses; if it hides status and headers, add one raw-response helper in the fork part, not in `bookorbit_api_service.dart`).
- Produces:
  - `extension ForkStoryGuideApi on BookOrbitApiService { Future<StoryGuideFetch> storyGuide(String fileId, {String? etag}); }` with `sealed StoryGuideFetch`: `GuideFresh(Map<String, dynamic> json, String etag)`, `GuideNotModified()`, `GuideMissing(String reason)`, `GuideUnreachable()`.
  - `class StoryGuideStore { Future<StoryGuide?> cached(String serverKey, String fileId); Stream<StoryGuide?> watch(BookOrbitApiService api, String serverKey, String fileId); }`: emits the cached copy first, then the fresh one on 200, `null` on 404 (and deletes the cache), keeps the cache on 304 and on unreachable. Files under the app support directory, one JSON + ETag per server and file.
- [ ] **Step 1: Write the failing tests** with a fake fetcher: 200 then 304 keeps one emission of the guide; 404 deletes the cache and emits null; unreachable with a cache emits the cache only; unreachable without a cache emits null; two servers with the same file id do not share a cache.
- [ ] **Step 2: Run and expect FAIL.**
- [ ] **Step 3: Implement.** Path `'/story-guide-content/files/$fileId'`, query `format=1`, header `If-None-Match`.
- [ ] **Step 4: Run and expect PASS.**
- [ ] **Step 5: Stop for review.**

### Task 5: Reader button and sheet with People / Places / Terms / Story

**Files:**
- Create: `lib/widgets/fork/constellations_sheet.dart`
- Create: `lib/widgets/fork/constellations_list.dart`
- Create: `lib/widgets/fork/constellations_story.dart`
- Create: `lib/widgets/fork/ebook_reader_constellations.dart` (`part of '../ebook_reader_view.dart'`: holds the reader's guide state, the store subscription and `_forkShowConstellations()`)
- Modify: `lib/widgets/ebook_reader_view.dart`: one `part` line; the `'constellations'` id in the bar-button list at the editor (`const ['bookmark', 'readalong', 'notes', 'autoscroll', 'settings', 'chapters']`) and one case each in `_barButtonShown`, `_barButtonIcon`, `_barButtonLabel`, `_runBarButton`, each delegating to the part. Stay within 10 lines; if not possible, route all four switches through one fork helper and note it in "Copies and bypasses".
- Test: `test/fork/constellations_sheet_test.dart`

**Interfaces:**
- Consumes: `GuideView`, `cutGuide`, `readerCut`, `StoryGuideStore` (Tasks 2 to 4).
- Produces: `Future<void> showConstellationsSheet(BuildContext context, {required StoryGuide guide, required ValueListenable<ReaderCut> cut, required bool sectionMatches, required void Function(GuideQuote) onJump})`.
- Look: boards 1, 2, 4 of the mockups. Draggable sheet 0.6 to 0.9 like `_showAnnotationsSheet`; header with the cut chip text `'Up to Ch $n · $pct%'` (section title when known); search field `'Search names'`; `'In this chapter'` chips; tabs `'People'`, `'Places'`, `'Terms'`, `'Story'` with counts on the first three; rows with initials, name, `'NEW'` mark, newest line, `'$n ties'`; Story tab with summaries oldest to newest, `'You are here'` row, older ones folded behind `'Show chapters 1 to $k'`. Colors from the reader's color scheme like the settings sheet (light palettes get a light sheet).
- [ ] **Step 1: Write the failing widget tests**: rows per tab match `cutGuide` output for the fixture at a mid-book cut; search filters by any shown name; a later-named alias is not searchable before its `at`; Story tab shows only summaries whose `through` is visible.
- [ ] **Step 2: Run and expect FAIL.**
- [ ] **Step 3: Implement.** The button shows only when the store has a guide for the open file.
- [ ] **Step 4: Run and expect PASS;** `python3 scripts/fork/surface.py` within budget.
- [ ] **Step 5: Stop for review.**

### Task 6: Character page, ties, quotes and jump

**Files:**
- Create: `lib/widgets/fork/constellations_entity.dart`
- Create: `lib/widgets/fork/constellations_family.dart`
- Test: `test/fork/constellations_entity_test.dart`

**Interfaces:**
- Consumes: `GuideView` entity and tie views, `onJump` (Task 5). Jump: close the sheet and display the passage by finding `q` inside spine item `s` (reuse the reader's existing find-text path, the one `findText`/`findChapterHint` feed).
- Look: board 3. Kind label, name, `'First named in $section'`, `'Also ...'` shown names, `'So far in the book'` card with `'As of $section'` and `'Earlier'` expander, Family (parents above, siblings and spouses beside, children below, from family-group ties), Ties grouped by upstream group order with the section of the first visible quote, tie tap lists visible quotes, Book Knowledge `'Often with'` rows under `'From Book Knowledge'` styled apart (dashed outline).
- [ ] **Step 1: Write the failing widget tests**: an entity at a cut before its second profile shows only the first; `Earlier` lists older profiles; Family shows a parent tie both directions correctly (`parent_of` a to b: a above b); a tie with a hidden end is absent; tapping a quote calls `onJump` with that quote; `links` rows appear only when the payload has links and both ends are shown.
- [ ] **Step 2: Run and expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and expect PASS.**
- [ ] **Step 5: Stop for review.**

### Task 7: Sky

**Files:**
- Create: `lib/widgets/fork/constellations_sky.dart`
- Create: `lib/services/fork/sky_layout.dart`
- Test: `test/fork/sky_layout_test.dart`

**Interfaces:**
- Consumes: `GuideView` (Task 2), group colors from `story_guide_tie_types.dart`.
- Produces: `SkyLayout layoutSky(List<SkyNode> nodes, List<SkyEdge> edges, {int seed = 1, int iterations = 300})` returning node positions in a unit square, run with `compute()` off the UI thread; `SkyNode { key, weight }`, `SkyEdge { a, b, group }`.
- Look: board 5. Ties only (no Together toggle). Node size by visible tie count; top 80 by tie count; legend chips toggle groups; `'Up to this page'` slider that only moves back (0 to the current cut, in sections); `InteractiveViewer` pan and pinch; tap a node opens its character page. Reached from a Sky icon button in the sheet header.
- [ ] **Step 1: Write the failing tests**: same seed gives the same layout; output has at most 80 nodes, keeping the most connected; no node outside the unit square; moving the slider back removes ties and nodes anchored after the slider's section.
- [ ] **Step 2: Run and expect FAIL.**
- [ ] **Step 3: Implement** (simple force-directed layout; cache per cut).
- [ ] **Step 4: Run and expect PASS.**
- [ ] **Step 5: Stop for review.**

### Task 8: States, notes and the live run

**Files:**
- Modify: `lib/widgets/fork/constellations_sheet.dart` (states)
- Modify: `FORK_NOTES.md` (every touched path, any Copies and bypasses row)
- Test: `test/fork/constellations_sheet_test.dart` (state cases)

- [ ] **Step 1: Write the failing tests**: offline with cache shows `'Offline. Showing the guide saved on $date.'`; no guide keeps the bar button hidden.
- [ ] **Step 2: Run and expect FAIL, implement, run and expect PASS.**
- [ ] **Step 3: Full checks:** `flutter analyze`, `flutter test test/fork`, `python3 scripts/fork/surface.py`, pre-commit hook dry run via `git diff --name-only` against `FORK_NOTES.md` rows.
- [ ] **Step 4: Live run** on the iOS simulator against the dev BookOrbit server with Task 1 running: open a book with a built guide, check the button, the cut chip, that a name first met two pages ahead is absent and appears after turning to it, the character page, a quote jump, the Sky, airplane mode with the cached copy.
- [ ] **Step 5: Stop for review.** Commits only when the user says.

## Shared UI interfaces (Tasks 5 to 7 run in parallel)

Set after Tasks 2 to 4 landed. Each worker builds against these exact signatures; Task 5 wires them.

- Built: `StoryGuide`, `GuideView cutGuide(StoryGuide, ReaderCut, {required bool sectionMatches})` (`lib/services/fork/story_guide_cut.dart`, `GuideView.byKey`, `entitiesByTab`, `tiesByEntity`, `linksByEntity`, `summaries`, `inThisSection`, `newInThisSection`); `StoryCutBridge(wc, guide)` with `Future<ReaderCut?> cut()` and `bool get lastCutMatches` (`lib/widgets/fork/story_cut_bridge.dart`); `StoryGuideStore` (`lib/services/fork/story_guide_store.dart`).
- Task 6 produces, in `lib/widgets/fork/constellations_entity.dart`:
  `class ConstellationsEntityPage extends StatelessWidget { const ConstellationsEntityPage({super.key, required StoryGuide guide, required GuideView view, required String entityKey, required String cutLabel, required void Function(GuideQuote quote) onJump, required void Function(String entityKey) onOpenEntity}); }`
  It renders board 3 for `view.byKey[entityKey]`; a missing key renders a short "Not met yet" line. `onOpenEntity` is used by tie and family rows.
- Task 7 produces, in `lib/widgets/fork/constellations_sky.dart`:
  `class ConstellationsSky extends StatefulWidget { const ConstellationsSky({super.key, required StoryGuide guide, required ReaderCut cut, required bool sectionMatches, required void Function(String entityKey) onOpenEntity}); }`
  It computes its own views with `cutGuide` for the slider position (a whole-section cut `(s: k, o: null, placedQuotes: {})` for k below the live cut; the live cut itself at the slider's end).
- Task 5 produces the sheet, list and Story tabs, the states from Task 8, the reader wiring (bridge `cut()` after relocate, debounced 300 ms; store `watch` on open), pushes `ConstellationsEntityPage` and `ConstellationsSky` inside the sheet's own `Navigator`, and owns every `FORK_NOTES.md` row for Tasks 5 to 7.

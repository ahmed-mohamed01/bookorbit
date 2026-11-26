# Web Story Guide tab

## Why

The server stores a story guide per book (characters, places, terms, ties, chapter summaries, a chronicle), but upstream only shows it in the official iOS app. The web client only has a status card (Build / Update). The owner wants the web book page to show the guide itself.

## What

A **Story Guide** tab on the book detail page, placed right after Chapters. It shows the guide cut at the reader's saved position, so nothing past where they are is shown.

Design reference (approved mockup, version 2): `/private/tmp/claude-501/-Users-ahmed-Desktop-repos-bookorbit--claude-worktrees-recursing-williamson-065bbf/da609493-c8b6-42cd-9d4f-9bf42a939273/scratchpad/story-guide-tab-mockup.html`. Match its layout and copy. Its data is hand-picked; the real tab reads the API.

Sections, in this order (side rail on desktop, sticky pill row on phones):

1. **Story so far** (default). "Where you stopped" card from the recap route's `stop.text`, then a "Previously" list from `previously` (chapter title + summary, newest first). A Refresh button refetches with `stop=1`. When `stop.state` is not `ok`, show the "Previously" list alone and a short muted line for the state (no position, Reading help off, budget, failed).
2. **Timeline**: chronicle notes up to the cut, grouped by chapter, oldest first, each with name chips that open the entity sheet. Ends with a "You are here" marker and a line saying how many chapters open as you read.
3. **Chapters**: every section title from `guide.sections` (titles are always shown, they are table-of-contents material). Chapters before the cut show their summaries (collapsed to two lines, click to expand). The chapter you are in shows its visible summaries plus "N later parts are hidden". Later chapters show the title, a lock and grey placeholder bars. Never put spoiler text in the DOM.
4. **Characters**: People / Places / Terms filter (same grouping as the apps: `character` is People, `place` is Places, every other kind is Terms), a name search, and cards with name, kind, importance bars, "Also known as" (only names whose first anchor is visible), the latest visible profile line, and "Since Chapter N". Main entries first.
5. **Constellation**: an SVG graph of visible entities. Star size = importance; solid lines = visible ties (thicker = more quotes); dashed lines = co-mention `links` (toggle). Selecting a star dims the rest and shows a side card with Open. Cap at 80 stars by importance then mentions. A simple deterministic layout is fine (no physics library needed; if you add one, pin an exact version and justify it).

Entity sheet (opens from cards, chips and stars; full screen on phones): title, kind, importance, "Since Chapter N", "Also known as" chips with the chapter each name first appears, "Who they are" (profile lines newest first, later ones labeled by chapter), "Recently" (chronicle notes about them), ties grouped in the apps' order (`STORY_GUIDE_TIE_GROUPS` or equivalent in `packages/types/src/story-guide-ties.ts`), "Often with" (top links). No "Suggest a fix" button in this change.

Top bar: "Up to N%, Chapter X: Title" with a progress track and chapter ticks, sub-line "Follows where you are, re-reads included". There is no way to move the cut: it always equals the saved reading position, re-reads included.

States: not built (reuse the existing story guide card / its build action, do not duplicate the build flow), building (reuse the status the card already gets), outdated (banner with Update, using the existing status), no reading position (show Chapters titles only, all locked, and Story so far's no-position line), guide is an upstream guide without BK extras (still works: every field it uses exists in format 1).

## Settled decisions

- Cut always follows the saved reading position; no manual cut, no reveal.
- Future chapter titles are shown; their summaries are not.
- Other names are shown as "Also known as", only those already seen.
- Story so far comes from the existing recap prompts (Reading help `recap-stop` and `recap-note`) through the fork recap route. No new prompt.

## Data

- Guide: `GET /api/v1/story-guide-content/files/:fileId` (fork route, full `StoryGuidePayloadV1`, ETag). The file is the guide's source file; find how `StoryGuideCard` / `useStoryGuideStatus` pick the file id for a book and reuse that.
- Recap: `GET /api/v1/story-guide-content/files/:fileId/recap?stop=1|0` (fork route, `server/src/modules/fork-story-guide/`).
- The cut: extend the recap response with a `cut` the client can apply, computed on the server where the chapter text is available:
  - `cut: { s: number; placedQuotes: string[] } | null`. `s` is the reader's spine index (`placed.chapterIndex`). `placedQuotes` are the distinct quotes `q` of every anchor in the guide whose `s` equals the reader's `s` (names, lines, profiles, joins, ties' quotes, links' `at`, summaries' `through`, chronicle anchors) that pass the same test `visibleSummaries` uses: every occurrence of the whitespace-collapsed quote in the chapter text ends at or before the offset. Null when there is no position.
  - Client rule (port of Absorb's `anchorVisible` with `matches = false`): an anchor is visible if `a.s < cut.s`, or `a.s === cut.s` and it is a quote anchor whose `q` is in `placedQuotes`. Section-end anchors in the current section are hidden. Hidden when in doubt.
  - With `stop=0` the route must stay cheap (no Reading help call) so the tab can load the cut on open and fetch `stop=1` for the recap text.
- Move the recap response type to a fork-owned file in `packages/types/src/` and import it from both sides (CLAUDE.md: shared types live there).

## Fork rules (read FORK_MAINTENANCE.md first)

- New code goes in fork-owned files: a new client feature folder (e.g. `client/src/features/story-guide-tab/`) with api, composables, lib (cut logic, view building) and components.
- Upstream files get the smallest hooks only: `book-detail-tabs.ts` (add the tab id), `BookDetailTabs.vue` (push the tab after Chapters), the book detail view that renders tabs (lazy-load and render the tab), the types index re-export, and English locale keys. Record each hook in FORK_MAINTENANCE.md (overlay section and conflict surface table).
- Show the tab only when the Story guides feature is usable for this book (the same condition the status card uses to render), and the book has an ebook file the guide can come from.

## Constraints

- Vue 3 `<script setup lang="ts">`, Composition API, bare-method event handlers (`vue/v-on-handler-style`), native `fetch` through the project's `api()` helper, Tailwind v4 classes with theme tokens only, lucide-vue-next icons, responsive (375 px phone width works).
- Scale: a guide can be over 1 MB with ~300 entities and ~5000 links. Build view models once per (guide, cut) in a composable, not in templates; virtualize or cap long lists if needed; never block the main thread on every keystroke of the search.
- Locales: add English strings; follow whatever `validate:locales` requires for the other catalogs.
- No em dashes anywhere. No new comments that restate the code.
- Logging on the server follows CLAUDE.md's `[event] [phase]` format; the recap already logs.

## Done when

- Server: recap returns `cut`; unit tests cover placedQuotes (quote before offset, quote after offset, quote repeated after offset, other sections excluded, no position -> null).
- Client: unit tests for the cut rule and view building (entities, names, profiles, ties, summaries, chronicle, chapters) against a small fixture, and a mount test for the tab's sections and states.
- `pnpm run verify:fast` passes (run with `NODE_OPTIONS=--max-old-space-size=8192`).
- FORK_MAINTENANCE.md records the new overlay and hooks.

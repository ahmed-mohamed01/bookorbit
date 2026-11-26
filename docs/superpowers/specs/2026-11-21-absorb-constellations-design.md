# Constellations in Absorb: design

Date: 2026-11-21. Mockups: https://claude.ai/artifact/27PFxPJuLcmizP4uYB8UBv (boards 1 to 6).

## Intent

BookOrbit v3.9.0 builds AI story guides (`StoryGuidePayloadV1`: entities, ties, profiles, chapter
summaries, each anchored in the book). Only the attested BookOrbit iOS app can read them, as
"Constellations". The user reads on Absorb, their fork of an Audiobookshelf client (Flutter, iOS and
Android) that already talks to BookOrbit. They want to see a book's guide inside Absorb's ebook
reader, spoiler-safe at their current position. Book Knowledge (a fork pipeline in progress) emits the
same payload plus a fork-only `links` array, so the viewer shows those too.

## Goals

- A Constellations panel in Absorb's reader: People, Places, Terms, Story tabs, a character page, and
  a Sky graph of ties.
- Nothing past the reader's position is ever shown.
- Opens offline once a guide has been fetched.
- Looks like Absorb (dark Material, its sheet and tab patterns), laid out after the iOS app.

## Non-goals

- Building, retrying or deleting guides from Absorb. That stays in BookOrbit web.
- Mention counts, "Ask about the story", Story Recap, and the Sky's "Together" mode. The payload has
  no mention or co-occurrence data and these need text scanning or a model on the phone.
- Shared fixes (corrections) from Absorb.
- A web client viewer. Possible later on the same server route.

## Anti-goals

- Any spoiler: a name, line, tie, quote, summary or node from after the cut. A wrong cut is a
  failure even if everything else works.
- Opening guide content to API keys, or to users who cannot see the book.
- Growing upstream files in either repo beyond small hooks.

## Constraints

- BookOrbit: fork rules in `CLAUDE.md` and `FORK_MAINTENANCE.md`. New behaviour in fork-owned files;
  record the overlay and surface in FORK_MAINTENANCE.md in the same change.
- Absorb: fork rules in `~/Desktop/repos/absorb/FORK_NOTES.md` (fork code under `fork/` folders,
  small hooks, every changed path listed, no new l10n strings, plain constants instead).
- Absorb's main checkout has uncommitted work on `autoscroll-follow` touching
  `ebook_reader_view.dart`. Work in a new worktree cut from `fork`.
- Scale: guides for long books can hold hundreds of entities and thousands of quotes. No per-frame
  work over the whole guide; compute the cut once per page turn or less.
- No commits unless the user says so in chat. No em dashes in any written output.

## Approaches considered

1. **Absorb reads the existing iOS route.** Impossible in production: the route needs App Attest,
   which only the BookOrbit iOS app has.
2. **Fork route on BookOrbit + panel in Absorb (picked).** One small read-only route reuses upstream's
   service; all UI lives in Absorb's fork folders. Absorb already knows the reader position.
3. **Web reader panel in BookOrbit.** Works on desktop but not where the user reads. Can reuse the
   same route later.

The user picked 2, with the Sky included.

## Design

### BookOrbit: one fork route

- `GET /api/v1/story-guide-content/files/:fileId?format=1` in a new fork-owned module (for example
  `server/src/modules/fork-story-guide/`), imported in `app.module.ts` (the existing registration
  hook) or inside an existing fork module if one fits.
- Calls the exported `StoryGuidesService.content(fileId, formats, user, ifNoneMatch)` unchanged. Same
  responses as upstream's route: `200` body + `ETag`, `304`, `404 { reason }`, `Cache-Control:
  private, no-cache`. Reuse `StoryGuideContentQueryDto`.
- Login token only: refuse API keys with the same `ForbiddenException` and `API_KEY_ROUTE_FORBIDDEN`
  code upstream uses (mirrors upstream's intent). Book access stays upstream's `verifyBookAccess`.
- The route passes the stored body through unchanged, so `links` reach Absorb once Book Knowledge
  stores its payload in the same artifact store.
- Tests: a controller unit test for 200, 304, 404, API key refused, no access. FORK_MAINTENANCE.md
  overlay entry and surface row.

### Absorb: data

- `ebookFile['ino']` is the BookOrbit file id (`bookorbit_mapper.dart`). Fetch with the user's
  Bearer token, `If-None-Match` from the cache.
- Read-along needs no special case (user, 2026-11-21): the user's books read along through
  BookOrbit's edition sync timing index on the plain EPUB, so the file Absorb opens is the plain EPUB
  the guide was built from. A separate read-along EPUB file is not a case to design for; if one is
  open and has no guide of its own, the "no guide" state applies.
- Cache the payload JSON and ETag per server + file id on disk. Show the cached copy at once, revalidate
  in the background, replace on 200. Offline: cached copy plus a quiet "Offline" line (board 6).
- Parse into Dart models for format 1, ignoring unknown fields. Unknown entity kinds go under Terms;
  unknown tie types use `label`. Tie groups and labels from upstream's registry
  (`packages/types/src/story-guide-ties.ts`; a JSON copy is at
  `server/src/modules/story-guides/test-fixtures/tie-types.json`).
- `links`: optional, shaped as `BookKnowledgeXrayLink` in the `book-knowledge` worktree
  (`packages/types/src/book-knowledge.ts`: `{a, b, score, count, at}` with an anchor). Each link goes
  through the same cut by its `at` and both ends. A link ties two entities that come up together
  (`score` is its strength, `count` how often), so the character page lists them as "Often with"
  rows, styled apart as "From Book Knowledge" (board 3; the mockup's "same person as" row is wrong).
  Tested with fixtures in this change (my call): Book Knowledge does not yet store its payload where
  `StoryGuidesService.content()` reads, and storing it there is Book Knowledge's work, not this one.

### Absorb: the cut

- The reader's position is a pair (spine index, UTF-16 offset in the server's flattened section
  text). An anchor `{s, o}` is visible when `s < cut.s`, or `s == cut.s` and `o <= cut.o`. An anchor
  `{s, end: true}` is visible when `s < cut.s`.
- Use the **end** of the page on screen (what has been seen), from the reader's relocate event.
- Getting `cut.o` (my call, after the builder check). `o` is only a hint; `q` is the exact quote.
  - Absorb builds its own raw text per section the way the server does (the server skips script and
    style text; see `rawSectionText` on the server) and checks it against `sections[].chars` and `h`.
  - Section matches: compare `o` numerically, with the page-end offset found in Absorb's copy.
  - Section does not match: place each anchor in the current section by finding its `q` in Absorb's
    copy; an anchor whose quote is not found counts as not visible.
  - Page-end offset unknown: whole sections only (cut at the end of the previous section).
  - Never estimate from a page fraction: a page share is not a text share and can run ahead.
- Rules applied once per cut change:
  - Entity shown if its first name's `at` is visible. Its other names only from their own `at`.
  - A join is its own entry before its `at`, part of the entity after.
  - `lines` and `profiles` shown when `through` is visible; the newest one is "So far", older ones
    under "Earlier".
  - Tie shown when its `at` is visible and both ends are shown. Only visible quotes are listed;
    the count is the visible quote count.
  - Summaries shown when `through` is visible.
- "In this chapter" chips: entities with any visible anchor (a name, tie quote) in the current section.
  "NEW": first name anchored in the current section.
- Unit tests for the cut, including the edge cases above (same section, `end` anchors, joins).

### Absorb: UI (mockup boards)

1. A "Constellations" reader bar button, added the same way as the other bar buttons (the bar is
   user-arranged). Shown only when a guide exists for this file (cached or fetched).
2. Draggable sheet like the Notes sheet (60% to 90%). Header with the cut chip ("Up to Ch 12 ·
   41%"), name search, "In this chapter" chips, tabs People / Places / Terms / Story. Rows: initials,
   name, NEW mark, newest line, tie count.
3. Character page inside the sheet: kind, name, first named in (section title), other names, "So far"
   card with "As of" and "Earlier", Family (from family ties: parents above, siblings beside,
   children below), Ties grouped by upstream's groups with the chapter of the first visible quote.
   Tapping a tie lists its visible quotes; tapping a quote closes the sheet and jumps the reader there
   (match `q` within spine item `s`). Book Knowledge rows styled apart (dashed, blue).
4. Story tab: summaries up to the cut, newest last, "You are here" with the current section title,
   older ones folded ("Show chapters 1 to 8").
5. Sky: Ties only. Nodes = shown entities (size by visible tie count), edges = shown ties colored by
   group, legend chips to toggle groups, a "Up to this page" slider that only moves back from the cut.
   Pan and pinch zoom. Layout computed off the UI thread and cached per cut; cap to the most connected
   entities (around 80) with the rest reachable from the list. Tap a node to open its character page.
6. States: no guide (link to the book in BookOrbit web), guide only for another file of the book
   (hidden), offline cached copy, guide still building (if the status route is cheap to call; else
   just "no guide yet").

### Left to the builder

- Module and file names, Dart model layout, cache location and format.
- How `cut.o` is found, within the rules above.
- Sky layout algorithm and rendering approach, within the bounds above.
- Exact colors and sizes, matching Absorb's theme and the mockups; reader palettes that are light
  should get a light sheet like the existing settings sheet does.

# Constellations round 3: "Where you stopped" on the book page

Date: 2026-11-21. Builds on round 1 (`2026-11-21-absorb-constellations-design.md`) and round 2
(`2026-11-21-constellations-chronicle-design.md`). Round 2 is built first; this round reuses its route
module and Absorb's guide models.

## Intent

When the user opens a book they are partway through on Absorb's book page, a card under About tells
them where the story stands before they press Read or Listen: what happened in the last chapter or two,
then what was going on on the page they stopped at. Upstream BookOrbit's iOS app does the second part
with its reading help recap (`recap-stop`), but that route needs App Attest and the app sends the text
itself.

## Goals

- A "Story so far" card on Absorb's book page (`book_detail_redesign.dart`, under About) for a book with
  a saved ebook position between 0% and 100%.
- "Previously": the guide's chapter summaries up to the saved position, newest last, the last two shown
  and older ones folded. Free, no model call.
- "Where you stopped": upstream's `recap-stop` answer on the stretch of text just before the saved
  position, chosen by the server (user's pick: B), so it works wherever the user read.
- Spoiler-safe: nothing after the saved position.

## Non-goals

- A recap from the audiobook position. Only the ebook file's saved position is used.
- Recaps inside the reader, or for books without an EPUB.
- New prompts. The answer is upstream's `recap-stop` as the iOS app gets it.

## Anti-goals

- A spoiler, from a position read wrong. When the position cannot be placed in the text, no "Where you
  stopped" is shown (summaries cut by whole chapters still can be).
- Model calls the user did not cause: no call on every book page open, only when the saved position has
  moved since the last answer.
- Bypassing upstream's reading help switches: off, budget, per-reader cap and access checks all apply.

## Constraints

- Round 1 and 2 constraints (fork rules in both repos, no commits unless the user says so, no em dashes).
- BookOrbit upstream edit: one line, adding `EpubDomService` to `PositionConverterModule`'s exports, so
  the fork route can read a chapter's collapsed text. Recorded in FORK_MAINTENANCE.md (surface table).
  Everything else in `server/src/modules/fork-story-guide/`.
- Upstream limits: one passage, at most `READING_HELP_MAX_PASSAGE_LENGTH` (12,000) characters.

## Approaches considered

1. **Absorb captures the last stretch when leaving the reader** and sends it. No upstream edits, but only
   knows positions reached in Absorb on that phone.
2. **The server picks the text from the saved position (picked by the user).** Works wherever the user
   read. Reuses upstream's position converter (`cfiPointToCollapsedCp`, `chapterIndexFromSpineStep`) and
   EPUB reader (`EpubDomService.getChapter`); one export line upstream.

## Design

### BookOrbit: `GET /api/v1/story-guide-content/files/:fileId/recap`

Same controller module as round 1 and 2, `@InteractiveOnly()`, `@CurrentUser()`.

1. **Position.** The user's `reading_progress` row for this file: `cfi` and `percentage`. No row, no CFI,
   or 0% / 100%: answer `{ state: 'no-position' }`.
2. **Place it.** Chapter index from the CFI's spine step; `getChapter(fileId, chapterIndex)`;
   `cfiPointToCollapsedCp(doc, cfi)` for the offset. Either step failing: position is the start of that
   chapter for "Previously" and `stop` is `{ state: 'unplaced' }`.
3. **Previously.** When the file has a ready guide (`StoryGuidesService.content()`), its `summaries`
   whose `through` is before the position: `{s, end: true}` when `s < chapterIndex`; a quote anchor in
   the current chapter when its `q` is found in the collapsed text before the offset. Sent as
   `{ through, text, title }` (title from `sections[]`), all of them; Absorb folds.
4. **Where you stopped.** The stretch: collapsed text ending at the offset, starting at the current
   chapter's start, or further back into earlier chapters while it is under 2,000 characters; trimmed
   from the front to 12,000 characters at a paragraph or sentence start. Then
   `ReadingHelpService.answer(user, { kind: 'recap-stop', fileId, language, passages: [stretch] }, signal)`,
   collected to its `done` text. `language` from the guide's `language`, else the request's
   `Accept-Language`, else `en`.
   - Upstream `READING_HELP_*` errors become `stop: { state: 'off' | 'budget' | 'cap' | 'failed', code }`;
     the response is still 200 with "Previously".
   - `?stop=0` skips the model call and returns `stop: { state: 'skipped' }` (Absorb uses it when the
     position has not moved since its stored answer).
5. **Response.**
   ```ts
   interface ForkStoryRecap {
     state: 'ok' | 'no-position';
     position?: { chapterIndex: number; percentage: number; cfi: string; chapterTitle: string | null };
     previously: { title: string | null; text: string }[];   // reading order, [] without a guide
     stop: { state: 'ok'; text: string; cached: boolean } | { state: 'unplaced' | 'skipped' | 'off' | 'budget' | 'cap' | 'failed'; code?: string };
   }
   ```
6. Logs: `story_guide.recap` start/end/fail with `fileId`, `userId`, `chapterIndex`, `stretchChars`,
   `cached`, `stopState`. Never the text.

### Absorb: the card

- Shown on the book page under About when the book has an ebook file from BookOrbit and a progress
  between 0% and 100%. Fork code under `lib/**/fork/`; the book page is already fork-owned.
- First paint from a stored copy (per server + file id: the response plus the CFI it was for). Then a
  request: `?stop=0` when the stored copy's CFI equals the book's current progress CFI, else a full one.
  Offline shows the stored copy with a quiet "Offline" line, or nothing if there is none.
- Layout: heading "Story so far"; "Previously" with the last two summaries, each with its chapter title,
  and "Show earlier chapters" folding the rest; "Where you stopped" with the answer and "Chapter N ·
  P%". While the answer loads, a one-line placeholder. States `off`, `budget`, `cap`, `failed`,
  `unplaced`: the "Where you stopped" part is hidden (`failed` shows a small "Try again"). With no
  summaries and no answer, the card is hidden.
- Copy as plain constants (fork rule): "Story so far", "Previously", "Where you stopped", "Show earlier
  chapters", "Try again", "Offline".

### Left to the builder

- Paragraph or sentence boundary detection for trimming the stretch.
- Where the stored copy lives (reuse round 1's guide store directory).
- Exact styling, matching the book page's section cards (the "Your reading" card is the nearest model).

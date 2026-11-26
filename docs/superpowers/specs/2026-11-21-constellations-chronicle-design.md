# Constellations round 2: chronicle pages

Date: 2026-11-21. Mockups: https://claude.ai/artifact/27PFxPJuLcmizP4uYB8UBv (boards 7 to 10).
Builds on `2026-11-21-absorb-constellations-design.md` (round 1), which stays in force except where
this document replaces it. Data contract: `constellations-chronicle-contract.md` in the shared notes
folder of the Book Knowledge design review session (copied into this repo by the build, see below).

## Intent

The round 1 viewer worked on a live run with The Calamitous Bob, but the user found the pages thin and
repetitive:

- Profiles are not fluent. Each "As of" entry repeats the same descriptors instead of reading like a
  story so far.
- Places, groups, objects and terms have no description at all (Mali shows an empty page).
- The main characters are not at the top of the list.
- Ties show as arrows and a raw quote snippet.
- In LitRPG books the user wants the character's current abilities and stats kept up to date.
- "Viv" and "Viviane Saint-Lys" show as two people at some positions.

The user wants each entity page to read as an intro, then a timeline of what happened to it chapter by
chapter, with links into the book that ask before jumping. For every kind of entity, listed only in
the chapters where it comes up.

## Who does what (user, 2026-11-21: "Yes, Book Knowledge")

- **Book Knowledge** writes the content: intros, timeline notes, abilities, pair descriptions, earlier
  joins, and fixes the Viv/Viviane merge. It takes the contract in its next round.
- **This work** owns the `chronicle` contract v1, the Absorb pages built against a hand-made Bob
  fixture in that shape, and a BookOrbit fork route change that serves `chronicle` only when one
  exists. No AI job here, and nothing reads upstream's step cache.

## Goals

- Absorb: people ranked Main / Supporting / Mentioned; the new character page (intro, abilities card,
  per-chapter timeline, ties with info boxes); place, group, object and term pages in the same layout;
  a confirmation before every jump and a way back after.
- All of it cut at the reader's position with round 1's rules.
- Works with any guide: with a `chronicle` the new pages, without one round 1's content in the new
  layout.
- The BookOrbit fork route adds `chronicle` to the guide when a source provides one, and changes
  nothing otherwise.

## Non-goals

- Generating chronicle content (Book Knowledge's work).
- Showing the chronicle in BookOrbit web or the iOS app.
- Fixing upstream's stray entities or merge mistakes.

## Anti-goals

- A spoiler. Absorb applies the cut to every chronicle entry and never shows a name, link or join the
  reader has not reached, even if the producer sends one.
- A guide that fails to load, or loads differently, because a chronicle is missing, broken or stale.
- Any edit to an upstream file in BookOrbit.

## Constraints

- Round 1 constraints still apply (fork rules in both repos, no commits unless the user says so, no em
  dashes, scale).
- Round 1's Absorb viewer is uncommitted in the `constellations` worktree; round 2 builds on it there.
- BookOrbit: changes stay in `server/src/modules/fork-story-guide/`. Record them in FORK_MAINTENANCE.md.

## Approaches considered

1. **A separate fork AI job in fork-story-guide.** Dropped: a second whole-book pass roughly doubles
   model time, and Book Knowledge already has most of the inputs.
2. **A step in upstream's guide build.** Ruled out: the build's name is 38 of its 40 characters, so
   any added step stops the server from starting.
3. **Book Knowledge writes it, this work defines the contract and shows it (picked by the user).**
4. **A first timeline from upstream's cached names-step notes.** Ruled out: it reads another module's
   private cache tables, and the notes are 8 words per passage, not per chapter.

## Design

### Contract

`chronicle` v1 exactly as in the shared contract note. In short: a top-level field with `version: 1`,
`basis` (the `builtAt` of the guide it was made with), `entities` by key (each with
`about`, `timeline` entries with a nullable `note` and a jump anchor `at`, optional `abilities`
snapshots holding the full list with `since` per item), optional `pairs` by `"a|b"` key, optional
`joins` by join key. Anchors are Book Knowledge's (`{s,o,q}` or `{s,end:true}`, optional `n`).

The build copies the contract into this repo as a TypeScript type in the fork module, and Book
Knowledge's own types will match it. Changing it after the build means a version 2.

### BookOrbit: serving it

- A fork port in `fork-story-guide/`, for example `CHRONICLE_SOURCE` with
  `find(textKey: string, user: RequestUser): Promise<unknown | null>`, provided by default with a
  source that always returns null. Book Knowledge later binds its own source. Nothing else changes in
  BookOrbit until then.
- The fork content route (round 1) asks the source after upstream's `content()` returns 200. When the
  source returns an object with `version: 1` whose `basis` equals the served guide's `builtAt`, the route adds it as `chronicle`; otherwise it serves the
  guide unchanged. A source that throws is logged (`story_guide.chronicle` `[fail]`) and the guide is
  served without it.
- ETag: when a chronicle is added, the ETag is the guide's ETag combined with a hash of the chronicle,
  so a new chronicle reaches a cached copy; without one it is upstream's ETag unchanged. `If-None-Match`
  is compared against the combined value.
- The route does not validate the chronicle's inner shape (Absorb is defensive); it only checks
  `version` and `basis`.
- Tests: no source / null source serves upstream's body and ETag unchanged; a matching chronicle is
  added and changes the ETag; a 304 works with the combined ETag; a stale `basis` or a wrong version is
  left out; a throwing source is logged and left out.

### Absorb: the Bob fixture

A hand-made `chronicle` for The Calamitous Bob, matching the real guide's keys and anchors up to
Chapter 14, with the board 8 and 10 text (Viv, Solfis, Arthur, Cernit, Fort Stone at least; a few
`null` notes; Viv's abilities in three snapshots; two pair descriptions; Viviane Saint-Lys's join
moved to section 5). Kept under Absorb's `test/fork/`. It also lets the user see the pages on the
emulator through a test-only switch (builder's call how), since no server sends a chronicle yet.

### Absorb: data and the cut

- Parse `chronicle` when present; unknown fields ignored, a version other than 1 or a `basis` other
  than the payload's `builtAt` ignored, a malformed entry skipped on its own (never the whole page).
- Everything in it goes through round 1's cut: an `about`, `timeline` or `abilities` entry shows when
  its `through` is visible; a pair description when its `through` is visible and a tie between the
  pair is shown.
- Entries hold from their unit's end, so mid-chapter the timeline stops at the previous unit; the
  "You are here" row shows the current chapter label with no text.
- A pair description written before a join is shown on the joined entity from the join on.
- Entity names inside notes and intros become links by matching names visible at the cut (longest
  first), and only to entities shown at the cut, so a link never reveals a join.
- A join shows as part of its entity from the earlier of upstream's `at` and `chronicle.joins[key]`.
- Entries whose key is in neither the entities nor the joins are ignored (a shared fix renamed it).
- Without `chronicle`, the same pages show round 1's content: the newest visible identity line as
  the intro, no timeline or abilities, ties without descriptions.

### Absorb: UI (boards 7 to 10)

7. **People list** grouped Main, Supporting, Mentioned by the entity's `importance` (1, 2, 3) when
   the payload has it (Book Knowledge emits it); otherwise ranked by visible timeline entries, then
   visible tie count. Places and Terms tabs use the same order, without groups.
8. **Character page.** Header: kind and group ("Character · Main"), name, other names. "Who she is"
   card: the newest visible intro, and under it a "Now" line, the newest upstream identity line.
   "Abilities and stats" card, only when a visible snapshot exists: rows by group, "as of" the
   snapshot's chapter, a "new" chip on items whose `since` is in the newest visible snapshot's unit. "Story so far"
   (my call: no pronoun, the guide has no reliable gender): one row per visible timeline entry, chapter label, the note (or "No significant changes" in
   muted italics), a jump icon; the reader's chapter is marked "You are here". Entity names inside
   notes and intros are links to their pages when that entity is shown. "Ties": one row per other entity: initials avatar, the
   other entity's name as a link, the relation in plain words; tapping the row opens an info box with
   the newest visible description and "Read in Chapter N" to the tie's first visible quote. The
   "Who she is" card title is likewise "Who they are" (my call).
   Round 1's "So far" / "Earlier" profile card is removed when `chronicle` is present.
9. **Jump.** Every jump (timeline icon, "Read in Chapter N", quote) asks first: "Go to Chapter N:
   Title?", the quote, "You're in Chapter M at P%. A button will bring you back here.", Cancel and Go.
   After Go, a "Back to Chapter M · P%" chip shows over the reader; tapping it returns to the exact
   prior position. The chip hides once used, or when the user dismisses it (my call: a small close
   control, and it also hides after the user navigates elsewhere through the table of contents).
   While the chip shows, the cut stays at the position the jump left from, so the guide does not
   shrink while the user looks back (my call); once the chip is gone, round 1's cut applies again.
10. **Place, group, object and term pages.** Same layout: "What it is" card (newest intro), "In the
   story" timeline listing only chapters where it comes up, ties. No abilities card.

### Left to the builder

- File names in `fork-story-guide/` and Absorb's `fork/` folders; how the Bob fixture is switched on.
- Ranking thresholds for Main / Supporting / Mentioned without `importance`, tuned so Bob at Chapter
  14 gives the board's grouping (Viv, Solfis, Arthur, Cernit main).
- Exact styling, matching the boards and Absorb's theme.

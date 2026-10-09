# Fork Changelog

Releases of the ahmed-mohamed01/bookorbit fork. Versions are `v<upstream base>-m<N>`; see [FORK_MAINTENANCE.md](FORK_MAINTENANCE.md). Upstream changes are in the [upstream releases](https://github.com/bookorbit/bookorbit/releases).

## v3.1.0-m2 - 2026-10-01

Upstream base: v3.1.0 · Previous: v3.1.0-m1

### Features

- **audiobookshelf:** show the Audiobookshelf link in Position sync and harden the push (2762bf11)
- **audiobookshelf:** push BookOrbit listening positions back to Audiobookshelf (67890d95)
- **client:** compact the link edition panel into a position sync timeline (eb19fb30)
- **reader:** sync read-aloud progress across linked audiobook and read-along books (85ed5bdf)
- **audiobookshelf:** sync listening position to the linked read-along book (97a0a7e8)
- **reader:** resume read-along following once the highlight is back in view (b728500c)

### Fixes

- **auth:** let WebSocket messages past the global JWT guard (21087740)
- **storyteller:** keep multi-file audiobooks in track order for read-along builds (f0c23b37)
- **book:** keep read-along sync working when Storyteller's narration differs from the chapters (e1d2b624)
- **server:** keep generated read-alongs attached, rebuildable and linkable (a2986cc2)
- **server:** file storyteller read-alongs through the book dock (51377453)
- **server:** keep generated read-alongs out of edition links (8abf5128)
- **reader:** pin the narrated sentence to the top while read-along follows (2679e620)
- **progress:** stop re-announcing progress that did not move (6a86735a)
- **dashboard:** keep shelves on screen during progress refreshes (6ec47cf7)

### Maintenance

- **dashboard:** hold the background refresh open to check the old shelf stays (5fde5b82)

### Upstream syncs

- Merge upstream/main (2855dbb8) into monitored (3ffbdd6a)
- Merge upstream/main (acce1e15) into monitored (dbe66afa)

## v3.1.0-m1 - 2026-09-27

Upstream base: v3.1.0

### Features

- **reader:** keep read-along playing while the reader scrolls (4bed34e9)
- **storyteller:** resume read-along builds after a restart and pin their notifications (a0fb628f)
- **storyteller:** queue read-along builds and notify progress (d6914d5b)
- **storyteller:** cancel builds and keep read-alongs attached across relinks (503667c6)
- **client:** redesign the Link edition and Position sync popovers (c2c8704b)
- **storyteller:** generate read-along EPUB3 books via Storyteller (cc673424)
- probe each format's own release date for monitored works (bc85ef60)
- detect monitored releases and notify their owner (a0701121)
- **metadata:** start a monitor from the request destination settings (13dc8d82)
- **metadata:** let the monitored catalog collapse its sections (00210fd0)
- **metadata:** warn when the releases feed has no audiobook dates (a31ea7af)
- **metadata:** give the monitored catalog a Display menu (4ac4f8e4)
- **metadata:** filter the monitored catalog on Hardcover slot data (196f1a9f)
- **settings:** configure monitored refresh cooldown (ea0ac549)
- require a Hardcover token for monitoring and warn when missing (cd117946)
- **authors:** add monitor author action to the authors page menus (667e76ab)
- add monitored authors and books with per-format auto-download (241b24fb)
- gate cross-format sync on active reading and auto-provision whisper models (ff045188)
- add a re-extract metadata library action (c1a8d1b8)
- show library and path context on audiobookshelf matches (3e2870d0)
- add audiobookshelf path mappings and stale cleanup (048e95e3)
- carry the fork overlays onto upstream v2.8.1 (d3ec0cd5)

### Fixes

- **reader:** restore section swipes in scrolled flow (d0fef8d0)
- **docker:** build a portable whisper-cli and name the signal when it dies (991bb766)
- **client:** stop the library detail panel crashing for non-superusers (858fc0cc)
- **metadata:** tell a Hardcover outage apart from an author with no books (25b07c60)
- **metadata:** pick the fullest Hardcover record when names collide (eb68822e)
- **metadata:** keep collapsed sections to their own grouping and name (06c90f69)
- read monitored acquisition state from the request, not from its id (28be26ff)
- quiet the audiobookshelf hot tier and unblock the full poll (859ebfb6)
- **client:** stop the detail page leaving a gap above the shelf (474fd6cf)
- hide book-state rows from deselected audiobookshelf libraries (5c7011a7)
- refresh abs context on rows the matcher skips (d7e2c913)
- attribute the review card's sides and ABS provenance (75e7d6c4)
- keep audiobookshelf imports off the hardcover read link slot (91acfe0e)

### Security

- scope monitored authors and books to their owner (09865f07)

### Database

- move monitored schema to the fork bootstrap and quiet boot logs (260eadad)

### Maintenance

- **reader:** mock attachHostTouch in the useFoliate spec (58800d8f)
- **client:** remove monitored author progress hint (450ca80a)
- **docker:** build branch images on push and dispatch (758a8300)
- **deps:** floor fast-uri override at 3.1.6 (dbdb6998)

### Upstream syncs

- Merge upstream/main (v3.1.0) into monitored (4f98500c)
- Merge upstream/main (v3.0.0) into monitored and shrink the fork surface (ff9727e4)
- Merge upstream/main (v2.10.0) into monitored and shrink the fork surface (7d72d5e9)

# Fork Changelog

Releases of the ahmed-mohamed01/bookorbit fork. Versions are `v<upstream base>-m<N>`; see [FORK_MAINTENANCE.md](FORK_MAINTENANCE.md). Upstream changes are in the [upstream releases](https://github.com/bookorbit/bookorbit/releases).

## v3.4.0-m6 - 2026-10-18

Upstream base: v3.4.0 · Previous: v3.4.0-m5

### Fixes

- **monitored:** match a trailing "Book N" title to the bare number (1b21dcb8)

## v3.4.0-m5 - 2026-10-18

Upstream base: v3.4.0 · Previous: v3.4.0-m4

### Features

- **authors:** mark watchlisted authors and offer removal (078fd7fb)

### Maintenance

- **release:** give upstream releases their own entries in the fork's list (9f3c8586)
- **release:** force-fetch version tags that origin holds as annotated copies (87dd2a15)
- **server:** move Shelfmark schema out of the Drizzle migrations (a6169799)

### Upstream syncs

- Merge upstream/main (ce118e38) into monitored (660d204e)

## v3.4.0-m4 - 2026-10-18

Upstream base: v3.4.0 · Previous: v3.4.0-m3

### Highlights

- **Watchlist asks before it guesses**: a library book with the same title but a different series number is no longer counted as owned or missing. It is flagged as a possible match and held back from automatic downloads until you accept or reject it. Your answers, and any book you link or unlink by hand, stick across every refresh.
- **Later volumes stop hiding behind volume one**: owning the first book of a series no longer marks Volume 6 or Book Seven as owned, so their releases get grabbed. The same check keeps Position sync from pairing different volumes.
- **Kind filters on the author page**: companions, box sets, translations and other non-book entries stay out of the watchlist by default, and the author page filters by kind instead of a review tray.
- **Torrent file lists for magnet releases**: when an indexer offers both a magnet and a .torrent, View files shows the real file list before you grab.

### Features

- **server:** list a release's files when it has a .torrent beside its magnet (4c6e5aef)
- **client:** give watchlist authors a silhouette placeholder (bc46fbeb)
- **server:** flag uncertain watchlist matches and let the owner fix them (3ff0c7e9)
- **monitored:** turn the author page Display menu into kind filters (25a25036)
- **monitored:** keep companions, box sets and translations out of the watchlist (4a2888ce)

### Fixes

- **series:** draw a full-size titled fallback for empty series stacks (c3e17e65)
- **client:** draw watchlist book covers with the shared placeholder (645f2a17)
- **monitored:** stop matching a different volume as the owned book (859ebb1e)
- **server:** re-run audiobookshelf matching after new books are added (5a5c2eb0)

## v3.4.0-m3 - 2026-10-17

Upstream base: v3.4.0 · Previous: v3.4.0-m2

### Highlights

- **Universal search**: Search your library, Watchlist, manga, light novels and Hardcover from one place with Cmd+K, and request or follow books you don't have yet straight from the results.

### Features

- **client:** search beyond the library in the command palette (4cc97f3d)

### Maintenance

- **release:** publish fork releases to the fork, not its parent (17e7b33e)

## v3.4.0-m2 - 2026-10-17

Upstream base: v3.4.0 · Previous: v3.4.0-m1

### Highlights

- **Watchlist**: The Monitored feature, revamped with a book panel that is easier to navigate and follow. Mark a book as a comic, anthology, collection and more, and the choice persists across refreshes.
- **Bulk downloads**: Select multiple books on the Watchlist and request their ebooks, audiobooks or both in one go.
- **Shelfmark integration**: Allow a self-hosted Shelfmark instance to be connected to BookOrbit as an indexer and download provider.
- **More series from metadata**: Books that belong in multiple series can fetch multiple-series membership from metadata sources that offer multiple-series.

### Features

- **server:** add Elscione as a Shelfmark source (a2d9d6f5)
- **client:** redesign the watchlist book panel around format cards (dc0bdc3e)
- **server:** add watchlist Mark as and keep owner choices across refreshes (3dfe54f0)
- **metadata:** fetch other series from providers that list several (bd41d2d7)
- **server:** add Shelfmark as an indexer and download client (3ef6a6c8)
- **client:** add watchlist select mode, bulk bar and sources picker (3bd7dcb6)
- **server:** add watchlist bulk requests and per-request release sources (9b83cd1e)
- **books:** show the artist on the book page (002ff467)

### Fixes

- **docker:** clear the novel-sources image scan findings (f70d82fa)

### Maintenance

- **release:** backfill fork releases and introduce the fork in the README (7c735d3e)
- **release:** cut a fork release on every monitored push (a0d8fb51)
- **client:** move the watchlist onto the shared browse header (84865384)

### Upstream syncs

- Merge upstream/main (428aefe8) into monitored (248f6bb4)

## v3.4.0-m1 - 2026-10-16

Upstream base: v3.4.0 · Previous: v3.3.0-m1

### Highlights

- **Manga and light novels**: Find a series, pick the chapters or volumes you want, and BookOrbit downloads them into your library. Requires a [Suwayomi](https://github.com/Suwayomi/Suwayomi-Server) instance for manga and the [novel-sources](https://github.com/ahmed-mohamed01/bookorbit/pkgs/container/bookorbit-novel-sources) container for light novels. See the [setup guide](https://github.com/ahmed-mohamed01/bookorbit/blob/monitored/docs/WEB_SERIALS_ADMIN.md) and the [user guide](https://github.com/ahmed-mohamed01/bookorbit/blob/monitored/docs/WEB_SERIALS.md).
- **Mini player**: Read-along narration keeps playing in a mini player after you close the reader.

### Features

- **web-serials:** get manga and light novels from online sources (bbd8890b)
- **server:** keep community ratings for watchlist books and show them in the drawer (6829a0d8)
- **client:** rework the watchlist drawer and cards around one status per format (98c7120d)
- **reader:** make the background narration pill movable and survive a reload (ae6e46db)
- **reader:** keep read-along narration playing after the reader closes (5dcd3d73)

### Fixes

- **monitored:** keep request ids and announcements across catalog churn (#2) (b7234861)

### Upstream syncs

- Merge upstream/main (2cc0906d) into monitored (5bee4da3)

## v3.3.0-m1 - 2026-10-13

Upstream base: v3.3.0 · Previous: v3.2.0-m1

### Highlights

- **Monitor from the author page**: Start monitoring an author without leaving their page. Monitoring is now per author only.
- **Cleaner release list**: Adjustable row density, a header filter, and release counts you can trust.

### Features

- **authors:** monitor an author from their page (fde1eb1d)
- **monitored:** add release row density and a header filter (1fbf3fd4)

### Fixes

- **monitored:** count releases the way each view draws them (d84b028a)
- **client:** show the global search above sticky page headers (54374ad5)
- **books:** stop Your Reading clipping and keep badges on one row (2a094632)
- **monitored:** keep long omnibus slugs inside the work id column (ac2f68d7)

### Maintenance

- **monitored:** remove the Books tab and per-book monitoring (7623eba8)
- **books:** remove the read-aloud sync card from book details (92d2afe3)
- **client:** drop the link badge from Currently Reading stacks (01a6022f)

### Upstream syncs

- Merge upstream/main (ddc7e848) into monitored (3675908d)
- Merge upstream/main (3e993af1) into monitored (0e9eff95)

## v3.2.0-m1 - 2026-10-11

Upstream base: v3.2.0 · Previous: v3.1.0-m1

### Highlights

- **Position sync, rebuilt**: A clearer Position sync panel that shows how the ebook, audiobook, read-along and Audiobookshelf item are connected, and what needs attention.
- **More accurate read-along sync**: Reworked the readalong-audiobook position sync to be more acurate.
- **One book, one reading history**: Linked ebook and audiobook editions share one spot in Currently Reading and one reading log.
- **Narration player**: A proper player for read-along narration, with smoother chapter changes.
- **Requests from monitored releases**: A new release of a monitored book can file its download request automatically.

### Features

- **client:** lay the Position sync panel out as one spine with an audio group (64caf342)
- **server:** let an edition link keep its read-along without an ebook (4e57b77d)
- **client:** redesign the Position sync panel as a modality chain (1721b7a1)
- **server:** expose paused Audiobookshelf matches, read-along attach and stale alignment (0bae4bec)
- **dashboard:** stack linked editions in Currently Reading (ae77dd9f)
- **books:** merge a linked work's sessions into one reading log (84951fde)
- **notifications:** expand long items, request from a release, open the request (cdc8c935)
- file download requests when a monitored release arrives (50ace8ff)
- **sync:** map read-alongs through stored narration offsets and show honest sync states (8b7ac97d)
- **reader:** replace the read-along narration bar with a pill and full player (9cfe46c2)
- **reader:** start read-along at the audiobook default speed (34ffb9c5)

### Fixes

- **reader:** save read-along progress on an interval instead of every sentence (53dc6727)
- **reader:** stop read-along repeating words after a stall (939a27dd)
- **client:** trim the Position sync panel and keep its rail joined (60301c9b)
- **reader:** keep the linked ebook's progress live while the audiobook plays (9748c4b6)
- **server:** stop proposing a sibling volume as the edition pair (fd4474e9)
- **monitored:** drop a subtitle that is nothing but a marketing tail (6da39c6b)
- **monitored:** store catalog titles without their marketing tail (02eddbce)
- **client:** keep the request table's title column readable (8c2acab7)
- **reader:** stream read-along audio so chapters change without a pause (0884dd1e)
- **auth:** let WebSocket messages past the global JWT guard (21087740)

### Maintenance

- **client:** remove the Reading Log position sync popover (e867698c)
- **release:** add fork issue, versioning and release protocol (126e2225)
- **notifications:** mark release announcements with their own icon (32c2df7f)
- record the read-along narration player overlay in FORK_MAINTENANCE.md (c139ab0c)

### Upstream syncs

- Merge upstream/main (8fecae94) into monitored (271b7419)
- Merge upstream/main (2855dbb8) into monitored (3ffbdd6a)

## v3.1.0-m1 - 2026-10-01

Upstream base: v3.1.0

### Highlights

- **Audiobookshelf sync**: Listening progress, finished books and sessions from Audiobookshelf show up in BookOrbit, and BookOrbit positions can be pushed back.
- **Position sync**: Link an ebook and its audiobook and pick up in one where you left off in the other. Requires link map to be built via whisper from the link panel in book description
- **Storyteller read-alongs**: Create read-along EPUB3 books from an ebook and its audiobook through your Storyteller server.
- **Monitored authors and books**: Get notified when an author or book you follow has a new release, and download the formats you want automatically.
- **Audiobookshelf sidecars**: The scanner picks up Audiobookshelf metadata and cover files.

### Features

- **audiobookshelf:** show the Audiobookshelf link in Position sync and harden the push (2762bf11)
- **audiobookshelf:** push BookOrbit listening positions back to Audiobookshelf (67890d95)
- **client:** compact the link edition panel into a position sync timeline (eb19fb30)
- **reader:** sync read-aloud progress across linked audiobook and read-along books (85ed5bdf)
- **audiobookshelf:** sync listening position to the linked read-along book (97a0a7e8)
- **reader:** resume read-along following once the highlight is back in view (b728500c)
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

- **storyteller:** keep multi-file audiobooks in track order for read-along builds (f0c23b37)
- **book:** keep read-along sync working when Storyteller's narration differs from the chapters (e1d2b624)
- **server:** keep generated read-alongs attached, rebuildable and linkable (a2986cc2)
- **server:** file storyteller read-alongs through the book dock (51377453)
- **server:** keep generated read-alongs out of edition links (8abf5128)
- **reader:** pin the narrated sentence to the top while read-along follows (2679e620)
- **progress:** stop re-announcing progress that did not move (6a86735a)
- **dashboard:** keep shelves on screen during progress refreshes (6ec47cf7)
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

- **dashboard:** hold the background refresh open to check the old shelf stays (5fde5b82)
- **reader:** mock attachHostTouch in the useFoliate spec (58800d8f)
- **client:** remove monitored author progress hint (450ca80a)
- **docker:** build branch images on push and dispatch (758a8300)
- **deps:** floor fast-uri override at 3.1.6 (dbdb6998)

### Upstream syncs

- Merge upstream/main (acce1e15) into monitored (dbe66afa)
- Merge upstream/main (v3.1.0) into monitored (4f98500c)
- Merge upstream/main (v3.0.0) into monitored and shrink the fork surface (ff9727e4)
- Merge upstream/main (v2.10.0) into monitored and shrink the fork surface (7d72d5e9)

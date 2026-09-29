# Storyteller read-along integration

This is a fork-only feature (see [`FORK_MAINTENANCE.md`](../FORK_MAINTENANCE.md)). It is not part of
upstream BookOrbit and is not covered by upstream's documentation or support.

## What it does

BookOrbit's read-along feature pairs an ebook and an audiobook (the fork's edition-link "chain-link")
and asks a [Storyteller](https://storyteller-platform.gitlab.io/storyteller/) server to align them
into a read-along EPUB3 with word-level narration. Storyteller does the actual alignment work; this
integration only drives it: it registers the pair with Storyteller, starts processing, waits for the
result, and imports the finished EPUB into BookOrbit as a new book. That new book becomes the third
member of the link, alongside the original ebook and audiobook.

The connection is **instance-level**, not per-user: one admin configures a single Storyteller server
(URL and a service-account username/password) under **Settings > Integrations > Storyteller**, and it
serves every BookOrbit user. Who can generate a read-along is controlled entirely by BookOrbit's own
permissions, not by anything in Storyteller:

- Generating a read-along requires the `LibraryUpload` permission on the source books and library.
  Rebuilding an existing one also requires `LibraryDeleteBooks` and access to the read-along being
  rebuilt.
- Configuring the connection (server URL, credentials, path mappings, transport, target library)
  requires `ManageAppSettings`.
- Storyteller's own per-user accounts and reading state are not used by BookOrbit at all; the service
  account is the only Storyteller identity this integration ever authenticates as.

## The service account

Create a dedicated Storyteller user for BookOrbit rather than reusing a personal one. BookOrbit only
needs it to import books, start alignment jobs, and read job status - it never reads or writes
anything else in Storyteller on that account's behalf. Keeping it separate means revoking BookOrbit's
access later is a matter of disabling one account, not rotating a password shared with a human user.

The password is encrypted at rest with `STORYTELLER_ENCRYPTION_KEY` (see below) and is never returned
by the settings API; the settings panel shows "Password configured" instead of the value once it is
saved, and a save that leaves the password field blank keeps the stored one, as long as the server URL is
unchanged. Changing the URL without supplying a password clears it, because the stored secret
belongs to the server it was entered for; the settings page blocks that save and says so.

## Two transports

Storyteller can receive a pair to align in two different ways. BookOrbit picks between them
automatically (`transport: auto`, the default), or an admin can pin one:

- **Shared paths.** When the BookOrbit and Storyteller containers can both see the same underlying
  storage, BookOrbit imports the pair _by reference_ - it hands Storyteller the paths, and Storyteller
  reads the source files and writes the finished EPUB directly onto that shared storage. No file ever
  passes through either process, so this is the fastest option and avoids double storage. It requires
  the shared-storage setup below to be in place; the settings panel's "Test connection" check reports
  whether it currently is.
- **API transfer.** When storage is not shared (or for a book that already exists in Storyteller under
  a path BookOrbit cannot resolve), BookOrbit uploads the source ebook and audio files to Storyteller
  over its API (chunked/resumable upload), and downloads the finished read-along the same way once
  it's ready. This works with any reachable Storyteller server, at the cost of transferring the audio
  twice.

`auto` uses shared paths whenever the test above reports them ready, and falls back to API transfer
otherwise - so it is a safe default in either setup, and stays safe if the shared-storage setup breaks
later.

## Shared-storage setup

To make the shared-paths transport available, mount the same storage into both containers:

- Mount BookOrbit's library folders into the Storyteller container **read-only**. Storyteller only
  needs to read the sources to align a pair, and it writes metadata tags into the files it imports on
  its own (BookOrbit never asks it to), so a writable mount lets it modify a user's source library.
- Give Storyteller one **staging folder** for its output, mounted **read-write**, and make it visible
  to BookOrbit as well. It must sit **outside every BookOrbit library folder**: Storyteller names the
  finished EPUB after the audio tags and writes those tags over the ebook's title and authors, so a
  library scan there would index every read-along with the wrong metadata. The build and the "Test
  connection" check both refuse a staging folder inside any library folder, compared by real path,
  so a symlink or a second spelling of a library folder does not get past it.
- In Storyteller's own settings, set its read-aloud location type to **`CUSTOM_FOLDER`** and point it
  at that staging folder (from Storyteller's side of the mount). The setting is global in
  Storyteller, so every reference-imported book on that server writes its read-along there.
- In BookOrbit's Storyteller settings, add a **path mapping** for every mount point that differs
  between the two containers: a BookOrbit-side prefix and the corresponding Storyteller-side prefix
  for the same storage, covering the source libraries and the staging folder. BookOrbit uses these
  mappings in both directions: to translate a source file's BookOrbit path into what Storyteller
  should read, and to translate the read-along path Storyteller reports back into the staging file
  BookOrbit reads. "Test connection" reports whether the mappings and Storyteller's read-aloud
  location line up, and explains what is missing when they do not.

If the mounts or the `CUSTOM_FOLDER` setting are not in place, BookOrbit falls back to (or can be
pinned to) API transfer, which needs no shared storage at all, only network access from BookOrbit to
the Storyteller server.

## A local Storyteller for development

A remote Storyteller cannot see the BookOrbit machine's library folders, so the shared-paths
transport can only be exercised end to end against a Storyteller that mounts the same storage. For
development, run one next to BookOrbit with its own compose file:

```yaml
services:
  storyteller:
    image: registry.gitlab.com/storyteller-platform/storyteller:latest
    restart: unless-stopped
    ports:
      - "8001:8001"
    environment:
      STORYTELLER_SECRET_KEY: ${STORYTELLER_SECRET_KEY:?openssl rand -base64 32}
    volumes:
      - storyteller_data:/data
      - ${EBOOK_LIBRARY_PATH:?}:/libraries/ebooks:ro
      - ${AUDIO_LIBRARY_PATH:?}:/libraries/audiobooks:ro
      - ${STORYTELLER_OUTPUT_PATH:?}:/libraries/output:rw

volumes:
  storyteller_data:
```

`STORYTELLER_OUTPUT_PATH` is a host folder that is not inside any BookOrbit library. Create the first
account through the web interface, set its read-aloud location to `CUSTOM_FOLDER` pointing at
`/libraries/output`, and then add one BookOrbit path mapping per mount: each library folder to its
`/libraries/...` mount point, and the output folder to `/libraries/output`. The first alignment
downloads a transcription model, so it is much slower than later ones.

## Where the finished read-along goes

BookOrbit holds the true copy of every read-along; Storyteller's output folder is only where the file
waits to be collected.

- **Filed through the Book Dock.** A new read-along is placed in the Book Dock under a row this build
  owns and filed straight away into the read-along library and folder chosen in the settings (or on
  the request), named with that library's naming pattern like any other docked book. Its metadata is
  the linked ebook's (title, subtitle, authors, series, description, publisher, dates, language,
  ISBNs, genres) plus the linked audiobook's narrators; nothing is read from the file Storyteller
  wrote. The read-along library is a plain filing destination, in either organization mode. The
  download is written under a hidden temporary name the dock never lists, and the dock row exists
  only for the moment it takes to file it.
- **Where the file comes from.** When Storyteller reports its read-along inside the configured
  staging folder and the file is there, BookOrbit takes it from disk. Otherwise (an uploaded book, a
  path outside the staging folder, or a path that resolves into a library folder) it downloads the
  read-along from Storyteller's API.
- **Rebuilds replace in place.** A rebuild of a pair that already has a read-along swaps the new file
  under the existing book, so it keeps its id, reading progress, shelves and link, and writes the
  linked editions' metadata onto it again (fields you locked on the read-along are left alone; file
  write and rename follow the library's own settings). This holds after the read-along was detached
  from the link too: its build still records it as the pair's output, and the rebuild attaches it
  again. A read-along book holding several EPUB files has its primary EPUB replaced.
- **Cleanup.** With "delete Storyteller copy after import" on (instance setting, or per request), the
  staged file is hard-linked into BookOrbit (copied when the two folders are on different file
  systems) and removed from the staging folder once the read-along is filed, and Storyteller's
  processing cache for the book is dropped. Storyteller deletes the whole book only when it owns
  every source file, which is only the case for an upload; a reference-imported book is never deleted,
  because deleting it would remove the source files it points at. With cleanup off, the staged file is
  copied and left where it is.

## One build at a time

A BookOrbit instance runs one read-along build at a time; further requests wait in a queue, oldest
first, and each shows its place in line. Alignment is a long job (`STORYTELLER_WAIT_CEILING_MINUTES`
defaults to 12 hours), so on a multi-user instance one long build can hold the slot for a long time.
Storyteller queues its own jobs independently; the cap is BookOrbit's, to bound how much transfer and
filing it drives at once. A restart re-queues the builds it interrupted: one Storyteller was already
working on resumes that same Storyteller book ahead of the queue, and one whose read-along was
already filed is marked ready and attached to its link on the next read.

## Environment variables

These are read once at startup (see `server/.env.example` for the authoritative list and current
defaults):

- `STORYTELLER_ENCRYPTION_KEY` - encrypts the service-account password at rest. Falls back to
  `JWT_SECRET` in development; set it explicitly in production. Generate one with
  `openssl rand -hex 32`.
- `STORYTELLER_REQUEST_TIMEOUT_MS` - timeout for ordinary Storyteller API calls (auth, settings,
  capabilities, job status). Defaults to 30000 (30s).
- `STORYTELLER_TRANSFER_TIMEOUT_MINUTES` - timeout ceiling for the API-transfer transport's uploads
  and downloads, which move whole audiobooks and can legitimately take a while. Defaults to 120.
- `STORYTELLER_WAIT_CEILING_MINUTES` - how long a read-along build keeps polling Storyteller for an
  alignment job to finish before it gives up and reports failure. Defaults to 720 (12 hours), since
  alignment of a long audiobook is a genuinely slow job. This is a ceiling per attempt, not an
  expected duration, and it is not carried across attempts: a build runs in-process, so a restart
  marks whatever was building as failed, and the retry resumes the Storyteller book it registered
  with a fresh ceiling rather than one already half spent.

## Known limitations

- **Read-along reading progress is displayed, not synced.** The popover shows the read-along's own
  percentage and narration percentage beside the ebook's and audiobook's, but progress is not merged
  across the three members the way the ebook and audiobook are. Two follow-ups would close it: a third
  arm in the edition link's progress union, and importing the read-along's SMIL anchors so the link
  sync becomes sentence-exact.
- **Storyteller's v2 API is not versioned for third parties.** The client pins the contract it was
  verified against and reads `server/capabilities` on connect. The connection test reports those
  capabilities back but does not currently validate them against what a build needs.
- **`readaloudLocationType` is global in Storyteller.** A `CUSTOM_FOLDER` setting applies to every
  reference-imported book on that server, not only BookOrbit's. Books that were uploaded keep their
  read-along inside Storyteller's own assets whatever that setting says, which is why the build decides
  how to collect from the path Storyteller reports rather than from the transport it registered with.
- **Storyteller writes into the files it imports.** It tags reference-imported source files on its
  own, which is why the source libraries must be mounted read-only into its container.

## Alignment quality is Storyteller's concern

Storyteller supports multiple alignment strategies (including MMS-based forced alignment) and its own
model/weight choices for transcription and alignment. BookOrbit does not configure, override, or have
any opinion on which aligner or model Storyteller uses for a given job - that is entirely Storyteller's
own settings. BookOrbit's "Test connection" check simply reports back what Storyteller says its
current aligner and import mode are, so the admin can see what a build will actually use.

## The three-way link

A read-along is always generated from an existing ebook <-> audiobook link (BookOrbit's edition-link
"chain-link" feature), never on its own:

- On the link popover, ticking **"Generate read-along"** when linking an ebook and an audiobook queues
  a read-along build immediately after the link itself is created. An already-linked pair that has no
  read-along yet gets a **"Generate read-along"** button in the same popover instead.
- Once a build exists, the popover shows all three members of the link - the ebook, the audiobook, and
  the read-along - each with its own status and progress. The read-along member's row shows its build
  phase and Storyteller's own task/progress while a build is running, and offers **Retry** on failure
  or **Rebuild** once it's ready. Rebuild replaces the read-along's file in place, keeping the book.
- The finished read-along is a normal, independent book in the designated read-along library. Nothing
  is attached to or rewritten on the original ebook or audiobook records.
- **Unlinking the pair does not delete the read-along book.** Unlink only removes the link row; the
  generated read-along stays in the library exactly as it is, simply no longer associated with that
  link. Relink the same pair and press **Generate read-along**: the existing book is reattached as the
  third member rather than built again, as long as it is still in the library and you can open it. A
  read-along book cannot start a link of its own; it only ever joins the pair that produced it.

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
  Replacing an existing one also requires `LibraryDeleteBooks`, and BookOrbit asks for confirmation
  before it deletes the read-along being replaced
  access to see the read-along output once it lands.
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

- Mount BookOrbit's existing library folders into the Storyteller container **read-only**. Storyteller
  only needs to read these to align a pair; it should never be able to modify a source library.
- Mount the folder for BookOrbit's read-along output library into the Storyteller container
  **read-write**. This is where Storyteller writes the finished EPUB when it imports a pair by
  reference.
- In Storyteller's own settings, set its read-aloud location type to **`CUSTOM_FOLDER`** and point it
  at that same read-along output folder (from Storyteller's side of the mount). Storyteller writes
  every reference-imported book's read-along output there, flat, named after the book's sanitized
  title - so this folder is not shared with any other Storyteller output.
- In BookOrbit's Storyteller settings, add a **path mapping** for every mount point that differs
  between the two containers: a BookOrbit-side prefix and the corresponding Storyteller-side prefix
  for the same storage. BookOrbit uses these mappings in both directions - to translate a source
  file's BookOrbit path into what Storyteller should read, and to translate Storyteller's read-aloud
  output path back into where BookOrbit should expect to find the finished file. "Test connection"
  reports whether the current mappings and Storyteller's read-aloud location actually line up, and
  explains what's missing when they don't.

If the mounts or the `CUSTOM_FOLDER` setting are not in place, BookOrbit falls back to (or can be
pinned to) API transfer, which needs no shared storage at all - only network access from BookOrbit to
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
      - ${READALONG_LIBRARY_PATH:?}:/libraries/readalongs:rw

volumes:
  storyteller_data:
```

Source libraries are mounted read-only because Storyteller writes metadata edits back into the files
it imports; the read-along folder is read-write because that is where it writes the finished EPUB.
Create the first account through the web interface, set its read-aloud location to `CUSTOM_FOLDER`
pointing at `/libraries/readalongs`, and then add one BookOrbit path mapping per library, each local
folder to its `/libraries/...` mount point. The first alignment downloads a transcription model, so
it is much slower than later ones.

## Read-along library organization mode

Either organization mode works, as long as the read-along lands as its own book rather than joining
one that already owns its folder. The rule the build and the "Test connection" check both apply:

> Shared paths are usable when the read-along location resolves to the target library folder itself,
> or the library is `book_per_file`.

Storyteller's `CUSTOM_FOLDER` output is flat - every book lands as a single EPUB directly in that
folder, named after its sanitized title, with no per-book subfolder. The scanner gives every file at
a library folder's root its own book whatever the organization mode, so a flat `CUSTOM_FOLDER`
pointed at the library folder is correct in both. One directory deeper is where it breaks: a
`book_per_folder` scan folds a whole subfolder into a single book, so every read-along written there
would be absorbed into one book instead of becoming its own.

When the location is nested and the library is not `book_per_file`, the build falls back to
api-transfer (which writes to the folder root itself and is unaffected) and the connection test says
so. "Test connection" also flags a target library that does not allow the EPUB format.

## One build at a time

A BookOrbit instance runs one read-along build at a time; further requests answer `busy` rather than
queueing. Alignment is a long job - `STORYTELLER_WAIT_CEILING_MINUTES` defaults to 12 hours - so on a
multi-user instance one long build can hold the slot for a long time. Storyteller queues its own jobs
independently; the cap is BookOrbit's, to bound how much transfer and scanning it drives at once.

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
- **Title collisions are detected, not prevented.** `CUSTOM_FOLDER` names files after the sanitized
  title, flat, and BookOrbit does not choose that name. Two books whose titles sanitize alike resolve
  to one path, so Storyteller overwrites whichever read-along is already there. A build predicts the
  path before registering and, when a book already owns it, either refuses (pinned `shared-paths`) or
  downgrades to api-transfer, whose filename carries the build id and the Storyteller uuid. The build
  that hit the collision is then correct, and the overwrite is logged with both book ids.
  The prediction is best effort, and this is the honest limit of the current design: BookOrbit predicts
  from its own stored title while Storyteller derives the name from the source EPUB, so the two can
  differ. A missed prediction means the overwrite happens with only the after-the-fact warning.
  The direction that removes the hazard rather than detecting it is to stop predicting names at all:
  point `readaloudLocation` at a staging folder that is not a BookOrbit library and hand the finished
  file to the Book Dock, whose `resolveUniquePath` already makes an ingested name unique, which can
  target a library on finalize and auto-finalize without a human. That would also collapse the two
  collect paths into one, which is where most of this feature's defects have lived. Three questions
  need answering first: whether the dock can ingest a file with its identity pinned, since a read-along
  is a derived artifact and its metadata should not be re-matched; that the three-way link tolerates an
  output book that appears only after finalize; and what the extra upstream surface costs, since the
  dock is upstream and this feature's hook surface is deliberately small.

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
  or **Rebuild** once it's ready. Rebuild asks for confirmation first, because it deletes the
  read-along it replaces.
- The finished read-along is a normal, independent book in the designated read-along library. Nothing
  is attached to or rewritten on the original ebook or audiobook records.
- **Unlinking the pair does not delete the read-along book.** Unlink only removes the link row; the
  generated read-along stays in the library exactly as it is, simply no longer associated with that
  link. Relink the same pair and press **Generate read-along**: the existing book is reattached as the
  third member rather than built again, as long as it is still in the library and you can open it. A
  read-along book cannot start a link of its own; it only ever joins the pair that produced it.

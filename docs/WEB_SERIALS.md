# Manga & Light Novels (Web Serials)

Manga & Light Novels lets you search for a manga or a light novel, pick the chapters or volumes you want, and have BookOrbit download them and file the finished books in one of your libraries. Connecting the manga sources and light novel sites is a one-time admin job: see [WEB_SERIALS_ADMIN.md](WEB_SERIALS_ADMIN.md). Everyone else only sees search, a preview and a **Get** button.

## What it is

- **Search** manga and light novels by title, or paste a link to a light novel.
- **Preview** a series: cover, synopsis, authors, status, and the list of chapters or volumes.
- **Get** the chapters or volumes you want. They download in the background and land in your library as CBZ (manga) or EPUB (light novels).
- **MangaBaka** (a public series database) supplies clean titles, authors, artists and volume numbers. It can be switched off by an admin.
- **Book Requests** can be used from the preview to ask for the licensed, published volumes of a series.

### Where the books come from

Manga comes from the **manga sources** your admin connected, and light novels from the **light novel sites** your admin enabled. Manga is filed as CBZ and light novels as EPUB.

Your server may offer only manga or only light novels. If the feature page says **Manga & Light Novels is not set up yet**, ask an administrator to connect a download source.

## How a download works

1. You search by title, or paste a link. The search asks the series database (MangaBaka) first and shows one result per real series, with cover, year, authors, status and an **In library** marker for series you already have books of, from any source. No manga source or novel site is searched at this point.
2. Opening a result shows the database's details at once and then looks for the series on the enabled sources: the manga sources the admin selected, and the light novel sites the admin enabled that you have not switched off. The most complete source is preselected under **Download from** and its chapters or volumes load. The other sources that carry the series can be picked instead. If no source has it, the preview says **Not available from your sources** and offers **Search the sites directly**.
3. **Get** queues a job. BookOrbit downloads each chapter or volume from the chosen source, merges manga chapters into volumes when asked, and hands each finished book to the Book Dock, which files it in the chosen library and folder.
4. A failed item is retried automatically after 2 minutes and again after 10 minutes. A job that ends with gaps can be retried from the queue, and a manga job can be moved to another source for its remaining chapters.

Downloads are per user. You see your own queue; an admin can see everyone's.

## Using it

You need the **Get manga and light novels** permission. Without it the pages are hidden.

### Searching

- Type a title in **Search by title, or paste a link** and press **Search**. Use **What to search** to limit it to **All**, **Manga** or **Novels**.
- Results are series. Use **Sort by** (**Relevance**, **Title A to Z**, **Source**) and the **Row density** switch (**Comfortable** or **Compact**) to change the view.
- While you type, suggestions appear. Series BookOrbit already knows are grouped as **Known series**.
- Results can be filtered by source with the source pills (**All**, then one per source).
- **Machine translations** (MTL) are marked **MTL**; use **Show machine translations** to include them.
- **Refresh** searches the sites again. The line above the results shows how old they are ("Results from 3 minutes ago"). **Retry failed sources** re-asks only the sites that failed.
- **Not in the list? Search the sites directly** (under the results) runs the older per-source search for series the database does not list. **Back to series results** returns. The same source search runs on its own, with a one line reason above the results, when the series database is turned off, unavailable, or has nothing for the query.
- **Pasting a link** skips the search and opens the preview. Links work for light novels from any supported site (the info tip next to the page subtitle lists them). Manga cannot be added by link.

### Light novel sources panel

The info tip next to the page subtitle opens **Light novel sources**. Under **Search these sites** you can switch off any site your admin enabled, for your own searches only. You can never switch on a site the admin did not enable, and sites the admin enables later start switched on. If you switch every site off, novel search returns nothing until you turn one back on. **Works with links** lists the sites whose links you can paste.

### The preview

- **Download from**: pick which source provides the chapters. Each shows its chapter count, last update, and a badge such as **Most complete**, **Same series** or **Title match**. A **Whole series** badge means the site has the whole series, not just this part, and its volumes are blocks of 100 chapters.
- **Which to get**: **All**, or **Choose range**. For a range, tap the first chapter (or volume), then the last. **Start**/**End** markers show your range. Quick picks: **Latest 10**, **First 10**, **Not in library**. **Clear** resets. Items already in your library are marked **In library** and are skipped.
- **How it lands in your library** chooses the layout:
  - Manga: **Per chapter** (one book per chapter), **Per volume** (one book per volume), **One book** (every selected chapter in one book).
  - Light novels: **Per volume** or **One book for the series**.
- **Library** and **Folder** choose where the books go. **Credits** lets you correct authors and artists; the MangaBaka match is shown, and **Not this series** rejects a wrong match.
- The footer shows what will happen ("12 chapters, 3 books, source") and **Get** starts it.

#### Manga volumes

With **Per volume** a manga is filed by these rules. The preview tells you how a selection will be filed before you press **Get**.

- Only whole volumes become a volume book: a volume is one book only when every one of its chapters is selected.
- Chapters that belong to no volume (for example the newest chapters not yet collected) download separately, one book per chapter.
- Chapters of a volume that is only partly selected also download separately, one book per chapter.
- A chapter range snaps outward to whole volumes: it widens to the first and last chapter of every volume it touches, so a range never produces a half volume. The preview shows the widened range.
- Volume membership comes from the source's own chapter names when they say so, otherwise from the volume data in the series database. If neither knows the volumes, the per-volume option is unavailable and chapters are filed one by one.
- The newest volume of an ongoing series can still gain chapters. It is titled with the chapters it holds, for example "Series, Volume 12 (Chapters 100-103)". When more chapters of that volume come out, getting it again files the longer copy as its own book; delete the shorter one when you no longer want it.
- **In library** means a book you already have covers every chapter of that volume. A volume counts as in your library only when a book from the same series covers its whole chapter range, so a shorter copy of the newest volume, or a volume numbered differently by another source, does not hide chapters you do not have.

### Published volumes and requests

If the series is licensed in print, or none of your sources carry it, and you can make Book Requests, the preview shows **Published volumes**. Each volume has a **Request** button that creates a normal Book Request, so approval, indexers and download clients behave as for any other request. **Request all missing** requests every volume without a request. If the series database does not know the last volume, enter **How many volumes?** yourself. Statuses are shown for requests made from here; people with the request-management permission also get **Find releases** and **Grab** inline. A request that was removed shows as **Not requested**.

### Get and the queue

**Get** shows a "Getting <title>" message and the job appears under **Queue**. Jobs are grouped as **In progress**, **Waiting**, **Paused** and **Recent**. Each shows progress ("Chapter 12 of 80"), what it is doing now, and any failed items.

| Action                     | What it does                                                                                                                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Pause** / **Resume**     | Stops a job and continues where it left off.                                                                                                                                            |
| **Move to top**            | Puts a waiting job first in line.                                                                                                                                                       |
| **Retry**                  | Retries failed items (the whole job, or one item via **Details**).                                                                                                                      |
| **Move to another source** | Manga only. Switches the remaining chapters to another source that carries the series. It shows how many remaining chapters each source has. Chapters the new source lacks stay failed. |
| **Cancel** / **Remove**    | Stops a job / removes it from the list. Books already added stay in your library.                                                                                                       |
| **Open**                   | Opens the series in its library.                                                                                                                                                        |
| **Clear finished**         | Removes your finished jobs from the list. Books stay.                                                                                                                                   |

Admins also get **Mine / Everyone**, and **Pause queue** / **Resume queue** for all users. While the queue is paused, running downloads finish and new ones wait. You can have at most 25 downloads at once, counting running, waiting and paused ones. Paused downloads count toward the cap, so cancel or finish one before starting another.

### Where files land

Books go to the **Library** and **Folder** you chose in the preview, or the admin's defaults if you did not choose. Manga is CBZ and light novels are EPUB, so the library must allow that format. Finished books go through the Book Dock into the library like any other book.

### Notifications

When a job finishes you get a notification: completed, completed with gaps, or failed. They have their own **Manga & Light Novels** category in your notification settings, so you can turn them on or off without changing Book Requests notifications.

## Troubleshooting

**"N sources could not be checked" / "N sources could not be searched."** One or more sites did not answer in time or blocked the request. The other results are still shown. Use **Retry failed sources**. Common causes: a site protected by a Cloudflare challenge (your admin can add a challenge solver), a slow site, or a site that is down. Searches on sites that need the solver can take much longer.

**A site moved to a new domain.** BookOrbit still uses the old address until the admin updates that site. Ask an admin to update or reinstall it.

**Light novel search returns nothing.** Check that you have not switched all sites off in the **Light novel sources** panel, and ask an admin whether at least one site is enabled and working. Until BookOrbit has indexed a site it still asks that site live, so a persistently empty result usually means no enabled site or a failing site.

**"Not available from your sources."** None of the enabled sources has this series. Try **Search the sites directly**, ask the admin to enable or install more sources, or use **Published volumes** to request the print edition.

**Error 502 or "credentials".** BookOrbit could not reach or log in to the download service behind the manga sources or light novel sites. Ask an admin to check the connection in the settings.

**Covers are missing.** Some sites block hotlinked covers or are slow. The book still downloads; the cover appears when the source or series database provides one.

**A long series takes a while to open.** Some sites list chapters across many pages, and each page is fetched at the site's polite rate, so a novel with thousands of chapters can take several minutes to open. The preview then shows "Loading the full chapter list from (site). Long series can take several minutes." and keeps checking while it stays open. The list keeps loading even if you close the preview, so opening it again later is quick, and the light novel service keeps the finished list for up to 30 minutes (at most 50 novels; the least recently used is dropped first, so a list can be gone sooner). **Get** shows the same message if the list is still loading; try again in a moment. A download that is already queued waits for the list on its own, up to about 31 minutes.

**The last volume of an ongoing novel.** Light novels from most sites are cut into volumes of 100 chapters. A shorter last volume is titled with its chapters, for example "Series, Volume 3 (Chapters 201-250)". Once the novel has more chapters, downloading it again files the longer copy as its own book; delete the shorter one when you no longer want it. A volume where more than half the chapters could not be fetched is never added; it fails with the count instead.

**Large downloads and retries.** Big series take a long time because sites are rate limited on purpose. Failed items retry automatically after 2 and 10 minutes. After that use **Retry** on the job, or, for manga, **Move to another source**. A job with gaps is **Added with gaps**. A failed job or one with gaps keeps what it already fetched until you remove or clear it (at most 14 days), so **Retry** continues where it stopped instead of starting over.

## Security and legal notes

- Light novel sites are read by third-party code that your admin installs and runs apart from BookOrbit; see [WEB_SERIALS_ADMIN.md](WEB_SERIALS_ADMIN.md#10-security-and-responsibility).
- BookOrbit does not check where manga sources come from. Admins should only add sources they trust.
- BookOrbit shows this note about sources: "Some sources publish works without the rights holder's permission. Admins choose which sources to enable, and users are responsible for making sure what they download is not licensed or that they have the right to it."

## Known limits

- **Follow is not built yet.** There are no scheduled checks for new chapters. This version has **Get** only, so a series is downloaded once when you ask.
- **Manga cannot be added by link yet.** Search manga by title.
- **Archive of Our Own (AO3) is not supported.**
- **Some manga sources always fail** because the site needs a real browser to get past its protection. Pick another source for the same title; the preview offers other sources that carry it.
- **Some sites work only by link.** On some setups Royal Road can be added by pasting a link but not found by title.
- At most 25 downloads per user, paused ones included, and a move to another source carries over at most 5,000 remaining chapters.
- Sites change without notice. Failures from a site that used to work are usually the site, not BookOrbit; the queue shows the reason per item and lets you retry.

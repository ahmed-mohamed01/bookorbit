# Manga & Light Novels: admin setup

This guide sets up the download engines behind **Manga & Light Novels** (internally Web Serials). For what the feature does and how people use it, see [WEB_SERIALS.md](WEB_SERIALS.md).

You can run either engine alone. The feature for a kind (manga or novels) switches on once its engine has a server URL saved, and stays on unless the last connection test failed. An engine that was never tested counts as on.

## What you are setting up

```
 browser
    |
 BookOrbit ----------------> Suwayomi            (manga, CBZ)       :4567
    |  \
    |   `-----------------> novel-sources        (light novels, EPUB) :8282
    |                            |
    |                            `--> FlareSolverr (optional, Cloudflare)  :8191
    |
    `--(optional, legacy)--> lightnovel-crawler  (light novels)      :8181
```

- **BookOrbit** talks to every engine over HTTP and files the finished books through the Book Dock.
- **Suwayomi** downloads manga and produces CBZ files.
- **novel-sources** runs LNReader source plugins and BookOrbit builds the EPUBs from what it returns. It runs third-party plugin code, so it gets its own hardened container and network.
- **FlareSolverr** is optional. novel-sources uses it for sites behind a Cloudflare challenge.
- **lightnovel-crawler** is the older light novel engine. It is optional and kept for people who prefer it.

## 1. Add the containers

The snippets below go into your existing BookOrbit compose file (the repository's `docker-compose.yml`). The `app` service is BookOrbit itself and is shown only as a stub: keep your real settings and database service as they are, and add the extra network.

Generate the token that BookOrbit uses to call novel-sources and keep it somewhere safe:

```sh
openssl rand -hex 24
```

```yaml
services:
  app:
    # ...your usual BookOrbit settings stay as they are; add the network. The database stays on the default network.
    networks: [default, novel-sources]

  suwayomi:
    image: ghcr.io/suwayomi/suwayomi-server:v2.4.2366
    restart: unless-stopped
    ports:
      # Only for opening Suwayomi's own web UI from this host. BookOrbit reaches it by name.
      - "127.0.0.1:4567:4567"
    environment:
      TZ: Etc/UTC
      AUTH_MODE: basic_auth
      AUTH_USERNAME: bookorbit
      AUTH_PASSWORD: change-me
      DOWNLOAD_AS_CBZ: "true"
    volumes:
      # Suwayomi's settings, extensions and downloads all live under this directory.
      - suwayomi-data:/home/suwayomi/.local/share/Tachidesk

  novel-sources:
    image: ghcr.io/ahmed-mohamed01/bookorbit-novel-sources:monitored
    restart: unless-stopped
    read_only: true
    tmpfs: [/tmp]
    security_opt: [no-new-privileges:true]
    cap_drop: [ALL]
    mem_limit: 1g
    cpus: 1.0
    environment:
      NOVEL_SOURCES_TOKEN: change-me # paste the openssl output here
      # Uncomment together with the solver profile below (docker compose --profile solver up -d).
      # NOVEL_SOURCES_SOLVER_URL: http://flaresolverr:8191/v1
    volumes:
      - novel-sources-data:/data
    networks: [novel-sources]

  # Optional: solves Cloudflare challenges for novel-sources.
  flaresolverr:
    image: ghcr.io/flaresolverr/flaresolverr:v3.5.2
    restart: unless-stopped
    profiles: [solver]
    networks: [novel-sources]

  # Optional and legacy: only if you want lightnovel-crawler as the light novel engine.
  lncrawl:
    image: ghcr.io/lncrawl/lightnovel-crawler:4.14.0
    restart: unless-stopped
    command: ["-ll", "server", "-p", "8181"]
    ports:
      # Only for opening its web UI from this host. BookOrbit reaches it by name.
      - "127.0.0.1:8181:8181"
    environment:
      TZ: Etc/UTC
    volumes:
      - lncrawl-data:/data
    healthcheck:
      test:
        [
          "CMD-SHELL",
          'python -c "import urllib.request;urllib.request.urlopen(''http://127.0.0.1:8181/health'')"',
        ]
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 30s

networks:
  novel-sources:

volumes:
  suwayomi-data:
  novel-sources-data:
  lncrawl-data:
```

Notes:

- `ghcr.io/ahmed-mohamed01/bookorbit-novel-sources` is the novel-sources image published from this repository's `container-image.yml` workflow (`ghcr.io/<owner>/<repo>-novel-sources`, so a fork publishes under its own owner). It is only rebuilt when the service's files change. Each build is tagged `:monitored` (moves with the `monitored` branch) and `:sha-<first 12 characters of the commit>`. To pin a version, pick a `sha-` tag from the package page on GitHub and use it in place of `:monitored`; a `sha-` tag exists only for commits that rebuilt the service.
- The first push of `bookorbit-novel-sources` to GHCR creates the package as private, so an anonymous `docker compose pull` fails with "denied". Make the package public in its GitHub package settings, or run `docker login ghcr.io` with a token that can read packages before pulling.
- `mem_limit: 1g` covers the default cap of 4 live plugin workers plus about 200 MB for the service: each worker is capped at a 160 MB heap plus 16 MB of young generation, about 200 MB at most with its native memory, so 4 x 200 MB + 200 MB = 1,000 MB. If you raise `NOVEL_SOURCES_MAX_WORKERS`, add about 200 MB per extra worker; for a smaller limit, lower the worker count or `NOVEL_SOURCES_WORKER_HEAP_MB` instead.
- `flaresolverr` has `profiles: [solver]`, so it does not start by default. To use it, start it with `docker compose --profile solver up -d` and uncomment the `NOVEL_SOURCES_SOLVER_URL` line. Leave the line commented while the solver is off: with it set, novel-sources reports a solver that is not there, searches wait for it, and challenged sites fail with "Solver request failed" instead of the real reason.
- The engines use named volumes, which work on any Docker host. If you prefer host directories (bind mounts), create each directory and give it to the user the container runs as before the first start, because Docker Engine creates a missing directory owned by root and the engine then cannot write to it:
  - novel-sources runs as uid and gid `10001`: `mkdir -p ./novel-sources/data && sudo chown 10001:10001 ./novel-sources/data`, then use `./novel-sources/data:/data`. `cap_drop: [ALL]` stops the container from fixing ownership itself.
  - For Suwayomi and lightnovel-crawler, look up the user with `docker run --rm --entrypoint id <image>` and `chown` the directory to the uid and gid it prints.
- Image tags are the tested versions. Check each project's documentation before moving to a newer tag.
- If BookOrbit and an engine share a Docker network, use the service name in BookOrbit's settings (`http://suwayomi:4567`, `http://novel-sources:8282`). The `suwayomi` and `lncrawl` services above are on the default network, so BookOrbit reaches them by name too. Otherwise use an address BookOrbit's container can reach. Their published ports are bound to `127.0.0.1` so only this host can open them; remove the `ports` entries if you do not need their web UIs. Do not expose any engine to the internet.
- Suwayomi keeps its own downloaded files and caches in its volumes. Finished books are copied into the BookOrbit library, so the engine volumes can be cleaned without losing books.

Start everything:

```sh
docker compose up -d
```

novel-sources refuses to start without `NOVEL_SOURCES_TOKEN`. Other optional variables (request spacing, timeouts, the worker cap and heap, the plugin index URL, safe mode) are listed in [services/novel-sources/README.md](../services/novel-sources/README.md).

## 2. Connect the engines in BookOrbit

Open **Settings > Server > Manga & Light Novels**. You need the **Manage app settings** permission (`ManageAppSettings`) to see it. Changes are applied with **Save changes** at the bottom.

### Manga: Suwayomi

1. On the **Manga** card choose **Connect**. The **Manga connection** sheet opens.
2. Enter **Server URL** (`http://suwayomi:4567`), **Username** and **Password**. BookOrbit sends HTTP Basic credentials, so turn on `AUTH_MODE: basic_auth` in Suwayomi and use the same values. Without authentication leave them empty.
3. Choose **Test**. A passing test shows the version and the number of sources. A failing one shows the reason.
4. Save. Changing the server URL clears the saved password, so enter it again.

Suwayomi ships with no sources:

1. On the Manga card choose **Manage sources**.
2. Open **Repositories** and add an extension repository you trust. BookOrbit does not check repositories.
3. Open **Available** and install extensions.
4. Back on the page, tick the sources that should be searched under **Sources**. Newly installed sources start unticked, and only ticked sources are searched.

### Light novels: LNReader sources

1. On the **Web novels** card choose **Connect**. The **Web novel connection** sheet opens.
2. Choose **Engine**: **LNReader sources**.
3. Enter **Server URL** (`http://novel-sources:8282`) and the **Token** you generated.
4. Choose **Test**. A passing test shows the version and how many sources are searchable.
5. Save.

BookOrbit also reads whether novel-sources has a Cloudflare solver configured (`NOVEL_SOURCES_SOLVER_URL`). When it does, BookOrbit waits longer for source answers, because solving a challenge is slow, and the Web novels card shows **FlareSolverr detected** after a passing test.

Then install sites:

1. On the Web novels card choose **Manage sources**.
2. Search the English catalogue and **Install** the sites you want. Apply any **Update** that is offered.
3. Make sure each installed site is **Enabled**. Only enabled sites are searched. **Remove** uninstalls a site and also removes it from the enabled selection.

Nothing installs or upgrades by itself.

Opening a novel whose site splits its chapter list across many pages can take minutes, because every page waits for the site's request spacing. novel-sources keeps loading such a list in the background (up to about 31 minutes) and keeps the finished list for up to 30 minutes (at most 50 novels, least recently used dropped first). This cache lives in novel-sources, not in BookOrbit. Users see "Loading the full chapter list" in the preview while it loads, and a download started meanwhile waits for it.

### Light novels: lightnovel-crawler (legacy)

Choose **lightnovel-crawler** as the **Engine**, use the URL of the container (`http://lncrawl:8181` with the compose above) and test. A saved lncrawl profile is also kept as a fallback for pasted links that no installed LNReader source recognises.

## 3. The light novel index

With the LNReader engine, BookOrbit keeps its own index of the novels each enabled site lists, so novel search, the **Download from** list and the search suggestions answer at once instead of asking every site. The **Light novel index** card sits under the engines.

- **Filling.** Every five minutes a background task works on one source. A new source is filled by paging its catalogue from the page it stopped at, about 20 novels per page and one page every 3 seconds, until the 2,000 page cap or an empty page. An empty page or a failed first page is checked again 3 hours later before the fill is treated as finished, so a site that was briefly down is not cut short. A site with 30,000 titles therefore takes on the order of an hour of paging, shared across the five minute cycles and the daily budget, so expect a first fill to take hours to a day for large sites. Once filled, a source is topped up every 3 hours from its latest listing.
- **Daily page budget per source.** The most catalogue pages BookOrbit may load from one site per day. Default 1,500, allowed range 10 to 20,000. When a site reaches it, filling pauses ("Paused until tomorrow") and continues from the same page the next day. Lower it to be gentler on a site.
- **Per-source rows.** Each installed source shows its state (Waiting, Filling, Indexing now, Indexed, Paused until tomorrow), titles indexed, when it last checked for new titles, pages used today, and its last error.
- **Fill now** runs a source next. **Rebuild** forgets what the index holds for that source and fills it again from the first page. **Refresh** reloads the card.
- Every live novel search result and every novel a user opens is added to the index as well.
- Until a source is filled, search still asks that source live, so nothing is blocked while the index grows.

The index lives in the `web_serial_novel_index` and `web_serial_novel_index_sources` tables. Title search uses the `pg_trgm` extension, which the migration runner installs.

## 4. Series details (MangaBaka)

The **Series details** card turns the MangaBaka lookup on or off with the **Look up series details** toggle. It also shows a status (Working, Failing, Not checked, Off, Paused).

- **What it does.** Looks each manga and light novel up in MangaBaka, a public series database, to fill in real authors, artists, the official title, publication status and volume numbers. For manga it also uses MangaDex to learn which chapters belong to which volume, so per-volume downloads work. Search itself starts from MangaBaka.
- **What it sends.** Only the series title and author. No user data leaves BookOrbit.
- **When it is off or failing.** Search falls back to the sources directly, books keep the names the source site gives (often missing or wrong), and per-volume manga downloads only work when chapter titles carry volume numbers. Downloads never stop. After 3 failed lookups in a row, lookups pause for 5 minutes and resume on their own.

Use **Test** on the card to check the lookup. It works only while the toggle is on.

## 5. Defaults

Under **Defaults**:

| Setting                                | Meaning                                                                                              |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Manga goes to** (library, folder)    | Where finished manga lands when a user does not choose.                                              |
| **Web novels go to** (library, folder) | Same for novels.                                                                                     |
| **Web novel books**                    | Default layout for novels: **Per volume** or **One book for the series**. Users can pick per series. |
| **Downloads at once**                  | How many series download at the same time across all users, 1 to 6, default 2.                       |

The target libraries must accept the format: manga produces CBZ and novels produce EPUB. A library whose allowed formats exclude the format rejects the job.

## 6. Permissions

| Permission                                                 | Allows                                                                                        |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `WebSerialAccess` ("Get manga and light novels")           | Search, preview, queue and manage your own downloads, pause and resume your own jobs.         |
| `ManageAppSettings` (with `WebSerialAccess` for the queue) | Everything on this settings page, seeing every user's downloads, and pausing the whole queue. |

Grant `WebSerialAccess` to the users or roles that should get the feature in the user's permissions (or in a role or permission preset). Users without it do not see the pages.

## 7. Book Requests for published volumes (optional)

The preview offers a **Published volumes** section when MangaBaka says a series is licensed in print or none of your sources carry it. It needs:

- the user has the Book Requests permission (`BookRequestAccess`, "Request books"),
- Book Requests has at least one enabled source (the check is `GET /book-requests/source-status`).

If either is missing the section simply does not appear. Users with `ManageBookRequests` also get **Find releases** and **Grab** inline for approved, searching or failed requests.

## 8. Verify it works

- [ ] `docker compose ps` shows suwayomi, novel-sources (and flaresolverr/lncrawl if used) running and healthy, not restarting.
- [ ] The Manga card **Test** passes and shows a version.
- [ ] At least one Suwayomi extension is installed and ticked under **Sources**.
- [ ] The Web novels card **Test** passes and shows searchable sources.
- [ ] At least one light novel site is installed and **Enabled** in **Manage sources**.
- [ ] The **Light novel index** card lists that site as Filling or Indexed.
- [ ] **Series details** shows Working.
- [ ] Defaults point at libraries that allow CBZ (manga) and EPUB (novels).
- [ ] A test user with `WebSerialAccess` sees **Manga & Light Novels**, can search, and **Get** puts a chapter in the queue and then in the library.
- [ ] If used: `curl http://novel-sources:8282/api/v1/health` from inside the network returns `"solver": true`.

## 9. Maintenance

### Suwayomi disk cleanup

Once BookOrbit has filed a manga chapter or volume in the library, it asks Suwayomi to delete its own downloaded copy of those chapters. The same happens when BookOrbit skips a unit because the book is already in the library. A unit that failed keeps its Suwayomi copy so a retry can reuse it. Cleanup is best effort: if Suwayomi cannot be reached the book is still imported and the failure is logged as `web_serials.engine_cleanup`. Chapters you downloaded in Suwayomi yourself are removed too when BookOrbit imports them.

### A source that stops novel-sources from starting

If a light novel site's plugin crashes novel-sources at start, so the service never comes up and **Manage sources** cannot be opened, set `NOVEL_SOURCES_SAFE_MODE: "1"` in the novel-sources environment and restart it. It then starts without loading any installed site; each shows as broken. Remove (or reinstall) the bad site in **Manage sources**, then remove the variable and restart.

### Updates

Update engine images by changing the tag and running `docker compose pull && docker compose up -d`. Light novel sites update only when you press **Update** in **Manage sources**.

## 10. Security and responsibility

### novel-sources trust model

- Sources come only from LNReader's published index. The index is a moving branch, so an installed plugin is pinned to a version, not to reviewed content. Its SHA-256 is checked on every start to catch a corrupted file; it does not stop a plugin that has broken out of its sandbox from changing files under `/data`.
- Plugins run in a Node VM inside a worker thread. The VM is not a security boundary: plugin code can reach the worker's `process`. The service runs under Node's permission model (reads only the app and `/data`, writes only `/data`, no child processes), workers start without the service's environment, the process functions that could end or signal the service are replaced with stubs, and the container is the real boundary, so keep the hardening options in the compose above (read-only root, `cap_drop: [ALL]`, `no-new-privileges`, memory and CPU limits, own network).
- A plugin can send requests to any address the container can reach, including BookOrbit and the solver. Keep novel-sources on its own network with only those two. novel-sources refuses novel and chapter addresses that point at a host other than the site's own (or one the plugin returned itself), so a user cannot steer a plugin to another address.
- A plugin's stored data, which can hold site cookies, is deleted when the site is removed.
- The service holds no BookOrbit secrets. It only knows its own token and the optional solver URL, and it sits on a network the database is not on.
- A source whose installed plugin fails to load is skipped at start and listed as broken, so the rest keep working. Reinstall or remove it in **Manage sources**.
- A stuck plugin call is killed when its timeout expires, and the next call gets a fresh worker.
- Updates are an explicit admin action.
- Keep the token secret and expose the service only to the BookOrbit server.

### Extension repositories

Suwayomi extensions are third-party code from the repositories you add. BookOrbit does not vet them. Only add repositories you trust.

### Responsibility

BookOrbit shows this note to users about sources:

> Some sources publish works without the rights holder's permission. Admins choose which sources to enable, and users are responsible for making sure what they download is not licensed or that they have the right to it.

As the admin you choose which sources are enabled. Enable only sites you are comfortable being responsible for, and remember that your users can only search what you enable.

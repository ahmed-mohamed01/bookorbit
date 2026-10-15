# BookOrbit Novel Sources

This service runs version-pinned [LNReader](https://github.com/LNReader/lnreader) light novel source plugins for BookOrbit. Downloaded plugins execute in a Node VM inside a worker thread, inside this separate service rather than in the main BookOrbit server. Each plugin call runs in a worker that is terminated when the call times out, so a plugin stuck in a busy loop cannot freeze the service. The VM keeps well-behaved plugins apart; it is not a security boundary (see the trust model).

BookOrbit uses the service to list and manage sources, browse and search their catalogs, fetch normalized novel metadata, and retrieve chapter HTML. It is not part of BookOrbit's own compose files; see the compose example below.

## Configuration

| Variable                            | Required | Default                     | Purpose                                                      |
| ----------------------------------- | -------- | --------------------------- | ------------------------------------------------------------ |
| `NOVEL_SOURCES_TOKEN`               | Yes      | None                        | Bearer token required by every route except health           |
| `NOVEL_SOURCES_DATA_DIR`            | No       | `/data`                     | Index cache, installed plugins, manifest, and source storage |
| `NOVEL_SOURCES_INDEX_URL`           | No       | LNReader v3 published index | Plugin index to cache and use as the install allow-list      |
| `NOVEL_SOURCES_SOLVER_URL`          | No       | None                        | FlareSolverr or Byparr API URL used for detected challenges  |
| `NOVEL_SOURCES_REQUEST_INTERVAL_MS` | No       | `1500`                      | Minimum time between request starts per source               |
| `NOVEL_SOURCES_MAX_IN_FLIGHT`       | No       | `2`                         | Maximum active requests per source                           |
| `NOVEL_SOURCES_FETCH_TIMEOUT_MS`    | No       | `20000`                     | Upstream request timeout in milliseconds                     |
| `NOVEL_SOURCES_MAX_WORKERS`         | No       | `4`                         | Live plugin workers across all sources                       |
| `NOVEL_SOURCES_WORKER_HEAP_MB`      | No       | `160`                       | Heap cap of each plugin worker (old generation)              |
| `NOVEL_SOURCES_NOVEL_WAIT_MS`       | No       | `45000`                     | How long `novel` waits before answering 202 pending          |
| `NOVEL_SOURCES_SAFE_MODE`           | No       | Off                         | `1` starts without loading installed sources (see below)     |
| `PORT`                              | No       | `8282`                      | HTTP listen port                                             |

The service refuses to start when `NOVEL_SOURCES_TOKEN` is missing. Protect the token as a secret and expose this service only to the BookOrbit server.

## API

All routes use the `/api/v1` prefix. Send `Authorization: Bearer <token>` except for health.

| Method   | Route                                            | Purpose                                                  |
| -------- | ------------------------------------------------ | -------------------------------------------------------- |
| `GET`    | `/health`                                        | Health, version, working and broken counts, `solver`     |
| `GET`    | `/sources/available?lang=English`                | Published sources with installation and update state     |
| `GET`    | `/sources`                                       | Installed sources, filter definitions, and `broken`      |
| `POST`   | `/sources/:id/install`                           | Download, validate, hash, and install an indexed source  |
| `POST`   | `/sources/:id/update`                            | Install a newer indexed version                          |
| `DELETE` | `/sources/:id`                                   | Remove an installed source                               |
| `GET`    | `/sources/:id/browse?page=1&latest=0&filters={}` | Browse one source                                        |
| `GET`    | `/sources/:id/search?q=term&page=1`              | Search one source                                        |
| `GET`    | `/sources/:id/novel?path=...`                    | Novel and chapter list, or 202 while it is still loading |
| `GET`    | `/sources/:id/chapter?path=...`                  | Return chapter HTML                                      |

Each source has two request lanes sharing one spacing and in-flight budget. Interactive requests take the next free slot ahead of bulk requests, and bulk gets one slot after three consecutive interactive slots so it cannot starve. `search` and `novel` default to `interactive`; `browse` and `chapter` default to `bulk`. Pass `priority=interactive` or `priority=bulk` on any of these four routes to override the default; other values return 400.

`GET /api/v1/health` returns `{ ok, version, installed, broken, solver }`. `installed` counts only sources that loaded and can be searched; `broken` counts installed sources that failed to load (or were skipped in safe mode). `solver` is `true` when `NOVEL_SOURCES_SOLVER_URL` is set, so BookOrbit can tell whether Cloudflare challenges can be solved.

Route deadlines, so a client can wait slightly longer than the service:

| Route               | Deadline                                                                    |
| ------------------- | --------------------------------------------------------------------------- |
| `browse`, `search`  | 30 s                                                                        |
| `chapter`           | 30 s                                                                        |
| `novel`             | 60 s, plus 3 s per chapter list page when the site pages it, at most 31 min |
| `install`, `update` | 30 s for the plugin download, plus loading it                               |

Some sites split the chapter list into pages. For those plugins `novel` fetches every page and returns the full list. The 31 min cap fits 600 pages at the default 1.5 s request spacing. A chapter that appears on two pages (the site added one while the list was being paged) is kept once, at its first position.

No `novel` response waits that long. The route waits up to `NOVEL_SOURCES_NOVEL_WAIT_MS` (45 s) for the load. If it has not finished, it answers `202 {"pending": true, "retryAfterMs": 5000}` and the load keeps running to its own deadline in the background, even if the client disconnects. Call again after `retryAfterMs`:

- Concurrent calls for the same source and path share one load, which keeps the priority lane of the call that started it.
- A finished novel is kept for 30 minutes (at most 50 novels, least recently used dropped first), so the next call answers at once with 200.
- A load that fails after a 202 keeps its error for 60 seconds and returns it, with the same status and code, to the next call. After that a call starts a new load.

For `browse`, `search` and `chapter`, a client that disconnects stops the plugin call and drops its queued requests, which then do not count against the source's spacing.

`novel` and `chapter` refuse (400) a `path` that would make the plugin fetch another host: an absolute URL whose host is not the source's site, a subdomain of it, or a host the plugin itself returned in earlier results; a `//host` path; a non-HTTP scheme; or a path that reaches another host when appended to a site address without a trailing slash.

Each source runs up to two plugin workers, and at most `NOVEL_SOURCES_MAX_WORKERS` (default 4) run across all sources. Workers are reused for calls and closed after 20 seconds idle. When the cap is reached, the oldest idle worker of any source is closed first; otherwise the call queues for the next free slot. A finishing worker keeps serving its own source unless another source is waiting with clearly fewer workers (none, or at least two fewer); then it closes and that source gets the slot, so one busy source cannot lock the others out. Loading a source (start, install, update) waits at most 30 seconds for a slot and otherwise fails with 503 and `TIMEOUT`. An idle worker costs about 30 MB; a busy one can grow to its heap cap (`NOVEL_SOURCES_WORKER_HEAP_MB`, 160 MB, plus 16 MB of young generation). That is enough to parse a single-page chapter list of 10,000 chapters. A call that needs more fails as a plugin error instead of growing the container. Fetching, the request spacing, the in-flight cap, the priority lanes, and plugin storage all stay in the main thread, so those limits hold across workers. Plugin storage is capped at 1,000 keys and 1 MB per store. When a store is full, its oldest entries (in insertion order) are dropped to make room; only a single entry larger than 1 MB is refused. A value that cannot be stored (one JSON cannot encode) or a failed disk write is refused and logged as `[novel_sources.storage] [fail]`; it never stops the service. Removing a source deletes its storage, which may hold site cookies.

Install, update and remove of one source run one at a time, so a remove sent during an update download takes effect after it instead of being undone by it.

A source whose installed plugin fails to load at start (missing file, checksum or version mismatch, boot error) is skipped and listed with `broken: true`. Its routes return 409 until it is reinstalled or removed.

The list of installed sources (`installed.json`) is written atomically and flushed to disk, with a backup (`installed.json.bak`) written first. If the list is empty or unreadable at start (for example after a power loss), the service starts from the backup, or with no sources when the backup is unreadable too, and logs `[novel_sources.read_manifest] [fail]`.

### Safe mode

If an installed source keeps the service from starting or crashes it, start once with `NOVEL_SOURCES_SAFE_MODE=1`. The service then loads no installed source; each is listed as broken, so an admin can remove (or reinstall) the bad one in **Manage sources**. Remove the variable and restart to return to normal.

### Cloudflare solver

When a site answers with a challenge and `NOVEL_SOURCES_SOLVER_URL` is set, the service asks the solver. One solve per site runs at a time; other challenged requests to that site wait for it and retry with its cookie. The solve runs apart from the call that started it, so a slow solve still stores its cookie for the next attempt even after that call timed out.

Source failures return a short message and one of `SITE_FAILED`, `CHALLENGE`, `TIMEOUT`, or `PLUGIN_ERROR`. Response bodies and cookies are never logged.

## Deployment

Run the published image on its own network that only BookOrbit (and the optional FlareSolverr) joins, so the service cannot reach the database network. The root filesystem is read-only; only `/data` and `/tmp` are written. The image starts Node with its permission model and expects `NOVEL_SOURCES_DATA_DIR` to stay `/data`. It runs as uid and gid `10001`.

The image is tagged `:monitored` (moves with the `monitored` branch) and `:sha-<first 12 characters of the commit>`. To pin a version, choose a `sha-` tag from the package page and use it in place of `:monitored`. Tags exist only for commits that changed the service. The first push of a new GHCR package creates it as private: make it public in the package settings, or pull with `docker login ghcr.io`.

`mem_limit: 1g` covers the default 4 workers at up to about 200 MB each (160 MB heap cap, 16 MB young generation and native memory) plus about 200 MB for the service and its cache of finished chapter lists: 4 x 200 MB + 200 MB = 1,000 MB. Add about 200 MB per worker if you raise `NOVEL_SOURCES_MAX_WORKERS`, or lower the worker count to fit a smaller limit.

```yaml
services:
  app:
    # The BookOrbit service from the repository's docker-compose.yml: keep its settings, add the network.
    networks: [default, novel-sources]

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
      NOVEL_SOURCES_TOKEN: change-me
      # Uncomment together with the solver profile (docker compose --profile solver up -d).
      # NOVEL_SOURCES_SOLVER_URL: http://flaresolverr:8191/v1
    volumes:
      - novel-sources-data:/data
    networks: [novel-sources]

  flaresolverr:
    image: ghcr.io/flaresolverr/flaresolverr:v3.5.2
    restart: unless-stopped
    profiles: [solver]
    networks: [novel-sources]

networks:
  novel-sources:

volumes:
  novel-sources-data:
```

The named volume takes its owner from the image, so it works on any Docker host. To keep the data in a host directory instead, create it and give it to the image's user before the first start, because `cap_drop: [ALL]` stops the container from fixing ownership itself:

```sh
mkdir -p ./novel-sources/data
sudo chown 10001:10001 ./novel-sources/data
```

Then use `./novel-sources/data:/data` in place of `novel-sources-data:/data`. Docker Engine creates a missing bind-mount directory owned by root, and the service then cannot start.

## Trust model

- Sources come only from LNReader's published index. The index is a moving branch (`plugins/v3.0.0`), so an installed plugin is pinned to a version, not to reviewed content.
- Each installed plugin's SHA-256 is checked on every start. This catches a corrupted or truncated file; it is not tamper protection, because an escaped plugin can rewrite files in `/data`.
- The VM is not a security boundary: plugin code can reach the worker's `process` through any host function. The defences are layered around it:
  - Node's permission model (set in the image's start command): the service reads only `/app` and `/data`, writes only `/data`, and cannot start child processes.
  - Workers start with an empty environment, so plugins cannot read the token from it. `process.kill`, its raw binding `process._kill`, `process.reallyExit`, `process.abort` and `process.dlopen` are replaced with stubs that throw, so a plugin cannot end or signal the service.
  - Storage messages from workers are validated and bounded.
  - The container is the real boundary, so keep the hardening options above.
- A plugin can send requests to any address the container can reach, including BookOrbit and the solver. Keep the service on its own network.
- The service holds no BookOrbit secrets. It only knows its own token and the optional solver URL, and it sits on a network the database is not on.
- A stuck plugin call is killed when its timeout expires, and the next call gets a fresh worker.
- Updates are an explicit admin action. Nothing installs or upgrades itself.

## Development

From this directory:

```sh
npx tsc -p tsconfig.json --noEmit
npx vitest run
```

Build the container from the repository root because the Dockerfile uses the monorepo lockfile:

```sh
docker build -f services/novel-sources/Dockerfile -t bookorbit-novel-sources .
docker run --rm -p 8282:8282 -e NOVEL_SOURCES_TOKEN=change-me -v novel-sources-data:/data bookorbit-novel-sources
```

## Licence

This service is AGPL-3.0 as part of BookOrbit. Files adapted from LNReader keep their MIT notice in `vendor/lnreader/LICENSE`.

## LNReader credit

The compatibility adapters are based on LNReader host libraries. LNReader and its plugin project are MIT licensed. The upstream license is retained at `vendor/lnreader/LICENSE`.

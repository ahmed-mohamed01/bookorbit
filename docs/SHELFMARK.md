# Shelfmark: requests setup

> [!IMPORTANT]
> **Disclaimer.** BookOrbit does not host, index, distribute or link to any books or other content, and does not advocate downloading content you do not own or have the right to access. This integration only gives you a cleaner way to connect a Shelfmark instance you run yourself, as a search agent for your own requests. Which sources you configure in Shelfmark, and what you download through them, is your responsibility. Check that it complies with copyright law and with each site's terms where you live.

This guide connects BookOrbit's book requests to [Shelfmark](https://github.com/calibrain/shelfmark). Shelfmark searches sources that need a browser to get through, such as Anna's Archive behind DDoS-Guard, and downloads what it finds. BookOrbit uses it in two roles:

- a **Shelfmark indexer**, which searches Shelfmark and lists its releases in the release picker next to your other indexers
- a **Shelfmark download client**, which hands a picked release back to Shelfmark, follows the download and imports the finished file through the Book Dock

You need both. A release a Shelfmark indexer finds can only be downloaded by Shelfmark, and the Shelfmark download client only takes releases a Shelfmark indexer found.

## What you are setting up

```
 BookOrbit --search--> Shelfmark --> Anna's Archive, Library Genesis, AudiobookBay, IRC
     |                    |
     |--grab, status----> |
     |                    v
     `<--reads files-- download folder (shared, or mounted into both)
```

- BookOrbit calls Shelfmark's API with Shelfmark's admin API key.
- Shelfmark writes finished files into its download folder.
- BookOrbit reads that folder through a path mapping and files the book through the Book Dock. The file is hardlinked when both sit on the same filesystem and copied otherwise.

## Requirements

- Shelfmark v1.4.0 or later, which added API key access.
- BookOrbit can reach Shelfmark over HTTP, for example `http://shelfmark:8084` on a shared Docker network.
- BookOrbit can read Shelfmark's download folder, for example the same host folder mounted into both containers.

## 1. Set up Shelfmark

### API key

Set `SHELFMARK_API_KEY` on the Shelfmark container to a long random value and restart it:

```sh
openssl rand -hex 32
```

BookOrbit sends it as `X-Api-Key`, and Shelfmark treats that request as an admin. Use this key, not `SHELFMARK_API_KEY_READONLY`: the read-only key can only read `/api/stats`, so search, queueing and status calls are all refused with 403.

### Output

In Shelfmark's **Settings > Downloads**:

- **Output Mode: Folder.** Other modes (email, Booklore) leave no file behind for BookOrbit to import, and the download fails with "Shelfmark finished but kept no file for BookOrbit to import".
- **Destination:** the folder you will mount into BookOrbit, for example `/downloads/shelfmark`. Keep it to Shelfmark's downloads so it does not double as a library another app moves files out of.
- **Audiobooks:** Shelfmark has a separate audiobook destination in the same tab. Point it inside the same mounted folder, or mount and map it as well.
- **Audiobook file organization: Rename and group.** Shelfmark reports only the first file of a download that wrote several. With Rename and group, a multi-file audiobook gets a folder of its own, and BookOrbit imports that whole folder. With Shelfmark's default (Rename) the chapters land loose in the destination, BookOrbit cannot tell them apart from other downloads, and the request is held for review instead. The ebook organization can stay as it is: see [Multi-file downloads](#multi-file-downloads).

### Anna's Archive

The Anna's Archive donator key belongs in Shelfmark, not in BookOrbit: **Release Sources > Direct Download > Download Sources > Account Donator Key**. With it, the "AA Fast Downloads" source unlocks. Keep it first under **Fast downloads** on the same page, so the key is used before any slow source. Anna's Archive mirrors are set on the **Mirrors** page next to it.

Shelfmark logs the fast download URL with the key in it. Remove `key=...` values before sharing Shelfmark logs.

### Network

If downloads are slow or keep failing over to slow sources, check that Shelfmark can resolve the sites it downloads from. Routers and ISPs often answer blocked shadow-library domains with `0.0.0.0`:

```sh
nslookup annas-archive.gl <your router's IP>
```

If the answer is `0.0.0.0` but a public resolver returns a real address, set Shelfmark's **Settings > Network > DNS Provider** to a public one and turn on **Use DNS over HTTPS**. Shelfmark can also route all of its traffic through WireGuard (`USING_WIREGUARD=true` plus the capabilities in Shelfmark's `compose/docker-compose.wireguard.yml`).

## 2. Mount the download folder into BookOrbit

Mount the same host folder into BookOrbit's container, read access is enough:

```yaml
services:
  app:
    volumes:
      - /mnt/user/downloads/shelfmark:/downloads/shelfmark:ro
  shelfmark:
    volumes:
      - /mnt/user/downloads/shelfmark:/downloads/shelfmark
```

If the two containers see the folder under different paths, that is fine: the download client's path mapping translates between them.

## 3. Add the Shelfmark download client

In BookOrbit, open **Settings > System > Requests** and choose **Add client**:

| Field                   | Value                                                                                                                                                                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Type                    | Shelfmark                                                                                                                                                                                                                                     |
| Base URL                | Shelfmark's address, for example `http://shelfmark:8084`                                                                                                                                                                                      |
| API key                 | the `SHELFMARK_API_KEY` value                                                                                                                                                                                                                 |
| Allow private addresses | on, when Shelfmark is on your LAN or Docker network                                                                                                                                                                                           |
| Path mappings           | Required. **Client path:** Shelfmark's destination as Shelfmark sees it. **BookOrbit path:** the same folder as BookOrbit sees it. Same path in both containers? Map it to itself. Add a second mapping for a separate audiobook destination. |

Shelfmark has no categories, so the form does not ask for one. **Test connection** reads Shelfmark's queue with the key.

The **Test hardlink** button checks whether the import can hardlink instead of copying. It fails whenever Shelfmark's folder is on a different filesystem from the Book Dock, for example a network share, and that is expected: the import then copies.

## 4. Add the Shelfmark indexer

Open **Settings > System > Requests** and add a source under **Direct feeds**:

| Field             | Value                                              |
| ----------------- | -------------------------------------------------- |
| Type              | Shelfmark                                          |
| Base URL          | the same address as the download client            |
| API key           | the same `SHELFMARK_API_KEY`                       |
| Shelfmark sources | which of Shelfmark's sources this indexer searches |

**Test connection** passes only when every chosen source is turned on and set up in Shelfmark.

### Choosing sources

| Source                             | Carries            | Notes                                                                                                                                                                                      |
| ---------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Anna's Archive (`direct_download`) | ebooks             | The main reason to use Shelfmark: it searches through Anna's Archive's bot check.                                                                                                          |
| IRC (`irc`)                        | ebooks, audiobooks | Only if you have set IRC up in Shelfmark.                                                                                                                                                  |
| Library Genesis (`libgen`)         | ebooks             | Leave out if BookOrbit already searches Library Genesis directly.                                                                                                                          |
| AudiobookBay (`audiobookbay`)      | audiobooks         | Leave out if AudiobookBay already reaches BookOrbit through Prowlarr. A torrent BookOrbit grabs itself gets an exact file list from your torrent client; one Shelfmark downloads does not. |

Searching a source BookOrbit already has lists every release twice and makes each Shelfmark search wait for the slower copy. For most setups, Anna's Archive alone (plus IRC if you use it) is the right choice.

BookOrbit only asks a source for the media it carries, so an audiobook request never searches Anna's Archive. To pick between sources per release, add one Shelfmark indexer per source.

## How it behaves

### Searching

- Shelfmark searches each chosen source separately. A source that fails or times out costs only its own releases.
- Each search gets up to 20 seconds. A source that hung or failed after 8 seconds or more gets a 4 second budget for the next 10 minutes, so one blocked site does not hold every search to its timeout. It gets a full-length try again once that time is up.
- Shelfmark does not wait for one of the three search slots that protect tracker accounts, and up to two searches of one Shelfmark indexer run at once, enough for a request and its other-format companion.
- An empty answer from Shelfmark is final. BookOrbit does not retry without the author, because Shelfmark's search already fans out across slow sites and a second pass mostly times out.

### Downloading

- A grab queues the exact release in Shelfmark. If Shelfmark is already working on it, BookOrbit follows that task instead of queueing it twice.
- BookOrbit polls Shelfmark every 5 seconds while a download is active and shows its progress.
- If Shelfmark refuses a release (source not set up, request policy), only that release is refused and automation moves on to the next one. If Shelfmark fails for a passing reason (its database busy, a disk error), the grab is retried like any unavailable client.
- A download cancelled in Shelfmark shows as "Cancelled in Shelfmark".
- Retrying a release whose earlier attempt failed, or whose file has since gone from the folder, queues it in Shelfmark again.
- Text from Shelfmark is shown and logged with links cut to their site and secrets such as `key=` removed.

### Multi-file downloads

Shelfmark reports only the first file of a download that wrote several, and says how many it wrote. BookOrbit then looks at the folder that first file is in:

- If the folder holds exactly those files and nothing else, BookOrbit imports the whole folder.
- If it holds other files too:
  - an **ebook** imports the reported file on its own, since each file is a whole book.
  - an **audiobook** is held for review, since importing one chapter would mark the request done. Set Shelfmark's audiobook file organization to **Rename and group** to avoid this.

## Troubleshooting

| What you see                                                                    | Likely cause                                                                                                                                              |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Shelfmark rejected the API key"                                                | The key is wrong, or it is the read-only key. Use `SHELFMARK_API_KEY`.                                                                                    |
| Indexer test: "Shelfmark has these sources turned off or not set up"            | Turn the source on in Shelfmark, or remove it from the indexer's sources.                                                                                 |
| Shelfmark searches take 15 to 20 seconds                                        | A slow source, usually Library Genesis. Remove sources BookOrbit already searches directly.                                                               |
| Downloads take minutes, or Shelfmark's log shows `aa-slow` instead of `aa-fast` | The fast download server is blocked by DNS, see [Network](#network).                                                                                      |
| "Shelfmark finished but kept no file for BookOrbit to import"                   | Output mode is not Folder, or another app moved the file out of Shelfmark's folder.                                                                       |
| "The downloaded content is not readable at ..."                                 | The path mapping is wrong, or BookOrbit's container cannot read the folder.                                                                               |
| "The download client no longer has this download"                               | Shelfmark restarted, or more than an hour passed before BookOrbit saw the download finish. Shelfmark keeps finished tasks in its queue for about an hour. |
| An audiobook request is held after downloading                                  | A multi-file audiobook landed in a shared folder. See [Multi-file downloads](#multi-file-downloads).                                                      |

## Security notes

- The API key gives admin access to Shelfmark. BookOrbit stores it encrypted, and only sends it to the Base URL you configured.
- Keep Shelfmark off the public internet, or behind authentication, since anyone with the key controls it.
- The Anna's Archive donator key stays in Shelfmark and never passes through BookOrbit.

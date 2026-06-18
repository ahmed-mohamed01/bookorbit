# Authoring the "What's New" highlights

This is the end-to-end guide for writing the `## Highlights` section of a GitHub release so it
powers BookOrbit's in-app **What's New** popup and the `/whats-new` archive. It is the single
source of truth for both the workflow and the format.

## How it shows up in the app

- **Popup:** when a user opens the app on a newer version than they last saw, a popup shows the
  highlights for the versions they missed (newest expanded, up to 4 versions cumulatively).
- **Archive:** the `/whats-new` page lists every release (highlights + full changelog).
- **Caching:** the server fetches and caches releases for about 10 minutes, so edits appear
  within a few minutes (immediately on a server restart). No redeploy is needed.
- **No highlights, no popup:** a release with no `## Highlights` section (or the scaffold left in
  place with no bullets) simply shows no popup. Its changelog still appears in the archive. That
  is fine for patch releases with nothing user-facing to call out.

## Walkthrough (every release)

1. **Cut the release.** Run the release workflow (Actions -> Release -> Run workflow on `main`).
   semantic-release creates the GitHub release as a **draft** and the Docker images
   (`:latest` and `:<version>`) are built and pushed. The draft is not visible in the app yet.
2. **Open the draft to edit.** Go to the repo's Releases, click the draft (or open
   `https://github.com/bookorbit/bookorbit/releases/edit/<tag>`), and click the edit (pencil) icon.
3. **Review the candidate highlights.** The `## Highlights` scaffold contains a commented list of
   this release's `feat` commits as starting candidates. Curate them: keep the user-facing ones,
   reword them into friendly benefit-focused lines, and delete the rest.
4. **Write the bullets** above the comment block, one per highlight (see the format below).
5. **Add an icon** to a bullet by ending the line with `<!-- icon: Name -->` (optional).
6. **Add media** by dragging an image or video into the editor (see the media rules below).
7. **Delete the scaffold comment block** once you are done with it.
8. **Validate:** from `server/`, run `pnpm whats-new:check <tag>` (lints, then previews exactly
   what the app will render and checks media reachability). Fix any warnings.
9. **Publish.** Click **Publish release**. Within ~10 minutes the popup appears for users on this
   version. (Until you publish, the draft stays hidden in the app even though `:latest` is already
   live, so do not leave it unpublished.)

## Copy-paste starter

```markdown
## Highlights

- **Two-way Kobo highlight sync** - Your highlights now sync both ways with Kobo, so a note on the device shows up on the web and vice versa. <!-- icon: BookHeart -->
- **Instant library scroll** - The alphabet jump rail is now instant on libraries with thousands of books. <!-- icon: Zap -->
- **Audiobook chapters** - Chapter markers are extracted and shown in the player; jump straight to any chapter. <!-- icon: Headphones -->

  <img width="800" alt="chapters" src="https://github.com/user-attachments/assets/REPLACE-WITH-DROPPED-IMAGE" />

- **Smaller fixes** - A batch of polish across the reader and library grid.
```

## Format reference

**Heading**

- The section heading must be exactly `## Highlights`.
- Everything after the next heading (`##` / `###`) or a `---` rule is treated as the technical
  changelog, not a highlight.

**Bullets**

- One highlight per line, starting with `- `.
- Shape: `- **Title** - one or two friendly sentences.`
- `**Title**` is the bold headline; the text after the `-` is the description.

**Icons** (optional)

- End the bullet with an HTML comment GitHub renders as nothing: `<!-- icon: Name -->`. It can
  also sit on its own indented line right below the bullet.
- `Name` is a PascalCase [lucide](https://lucide.dev/icons) icon name (e.g. `BookHeart`, `Zap`,
  `ShieldCheck`, `Headphones`, `Film`). Omit the comment for the default icon (`Sparkles`).
- Unknown names fall back to the default; the lint warns so you can fix a typo.
- The old `- [Icon] **Title** ...` prefix still parses but renders as literal `[Icon]` text on the
  GitHub page, so the lint warns against it. Use the comment form.

**Media** (optional)

- Drag an image or video into the GitHub release editor. GitHub uploads it and inserts either an
  `<img ... src="https://github.com/user-attachments/assets/...">` tag (images) or a bare
  `https://github.com/user-attachments/assets/...` URL (videos). Leave whatever it inserts as-is.
- Only **GitHub-hosted** media renders: `github.com/user-attachments/...` or any
  `*.githubusercontent.com` host. Media from other hosts (imgur, etc.) is dropped (the text is
  kept) and the lint warns.
- Image vs video is detected by file extension (`.mp4`, `.webm`, `.mov`, `.m4v`, `.ogv`, `.ogg`
  are video); GitHub's extension-less attachment URLs are probed for their content type.
- You can attach **several** media to one bullet (put each on its own line under it). They render
  as a horizontal gallery; clicking an image opens a carousel. At most **6** media per highlight
  render; extras are dropped (the lint warns).

**Soft limits** (the app clamps and the lint warns; nothing breaks)

- Title up to **120** characters, body up to **400** characters (visually line-clamped in the
  popup; the full text stays in the archive and search).
- Up to **12** highlights per release.

## Validate before publishing

Run from `server/`:

- `pnpm whats-new:check <tag>` - the one-stop check: lints, then previews exactly what the app
  renders (including a media reachability probe). Exits non-zero if the lint fails.
- `pnpm whats-new:lint <file.md>` / `pnpm whats-new:lint --tag <tag>` - static validation only.
  Add `--strict` to treat warnings as failures.
- `pnpm whats-new:preview [tag]` - render preview only.

Point these at a different repo for testing with the `GITHUB_RELEASES_REPO` env var (and
`GITHUB_RELEASES_TOKEN` for private repos / rate limits), or pass `--repo owner/name` to preview.

## Pre-publish checklist

- [ ] `pnpm whats-new:check <tag>` is clean (no errors; warnings addressed).
- [ ] Each bullet is `- **Title** - benefit.`, short and user-facing.
- [ ] Icons are valid PascalCase lucide names (no typos), or omitted for the default.
- [ ] Media was dragged in (GitHub-hosted), no more than 6 per highlight.
- [ ] Titles <= 120 chars, bodies <= 400 chars.
- [ ] The scaffold candidate/instruction comment block is deleted.
- [ ] Clicked **Publish release** (the draft is not enough).

## Common mistakes

| Symptom                                   | Cause                                                  | Fix                                                          |
| ----------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------ |
| Highlight shows the default Sparkles icon | Icon name typo / not a lucide name                     | Correct the PascalCase name (lint says which)                |
| `[Icon]` text shows on the GitHub page    | Legacy `[Icon]` prefix                                 | Move the icon into a `<!-- icon: Name -->` comment           |
| Image/video does not appear               | Media not GitHub-hosted                                | Drag the file into the editor (do not paste an external URL) |
| Only 6 of N images show                   | Over the per-highlight media cap                       | Keep the best 6                                              |
| Title/body looks cut off in the popup     | Over the soft length cap                               | Shorten it (full text stays in the archive)                  |
| No popup for the release                  | No `## Highlights` bullets, or release left as a draft | Add bullets and click Publish                                |

#!/usr/bin/env node
// Fork release notes.
//   Draft a CHANGELOG.fork.md entry from commits that are on the fork but not upstream:
//     node scripts/fork/release-notes.mjs vX.Y.Z-mN [--from <ref>] [--to <ref>] [--upstream <ref>]
//   Build the GitHub Release body (highlights, upstream merged in this release only, then the fork's changes):
//     node scripts/fork/release-notes.mjs vX.Y.Z-mN --release-body [--to <ref>] [--changelog <file>] [--image <ref>] [--allow-draft]
//   List the upstream releases a fork release brings in, as "<tag> <commit> <date the fork merged it>":
//     node scripts/fork/release-notes.mjs vX.Y.Z-mN --fresh-upstream [--to <ref>]
//   Build the body of the fork's mirror of an upstream release (upstream's own notes):
//     node scripts/fork/release-notes.mjs vX.Y.Z --upstream-release
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const UPSTREAM_REPO = "bookorbit/bookorbit";
const args = process.argv.slice(2);
const version = args[0];
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const upstreamMirror = args.includes("--upstream-release");
if (!version || !(upstreamMirror ? /^v\d+\.\d+\.\d+$/ : /^v\d+\.\d+\.\d+-m\d+$/).test(version)) {
  console.error("usage: release-notes.mjs vX.Y.Z-mN [--release-body] [--from <ref>] [--to <ref>] [--upstream <ref>]");
  process.exit(1);
}

const run = (cmd, a) => execFileSync(cmd, a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const git = (...a) => run("git", a);
const tryGit = (...a) => {
  try {
    return git(...a);
  } catch {
    return null;
  }
};

const to = opt("to", "HEAD");
const upstream = opt("upstream", "upstream/main");
const from = opt("from", tryGit("describe", "--tags", "--abbrev=0", "--match", "v*-m*", "--exclude", version, to));
const base = git("describe", "--tags", "--abbrev=0", "--exclude", "*-m*", to);
const range = from ? [`${from}..${to}`] : [to];
const HIGHLIGHTS_TODO = "<!-- highlights: write these before publishing -->";

const forkRepo = () => {
  const named = opt("repo", process.env.GITHUB_REPOSITORY);
  if (named) return named;
  return git("remote", "get-url", "origin").match(/github\.com[:/](.+?)(?:\.git)?$/)?.[1] ?? "ahmed-mohamed01/bookorbit";
};

if (!upstreamMirror && !version.startsWith(`${base}-m`)) {
  console.error(`warning: ${version} does not match the upstream base ${base} reachable from ${to}`);
}

// Bare #123 in upstream text means an upstream issue; on the fork it would link to the wrong one.
const qualifyUpstreamRefs = (text) => text.replace(/(^|[\s(])#(\d+)\b/g, `$1${UPSTREAM_REPO}#$2`);

const SEP = "\x1e";
const parseCommits = (raw) =>
  raw
    .split(SEP)
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => {
      const [sha, subject, body = ""] = c.split("\x1f");
      const m = subject.match(/^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/);
      const issues = [...body.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s+#(\d+)/gi)].map((x) => `#${x[1]}`);
      return { sha, type: m?.[1] ?? "other", scope: m?.[2], breaking: !!m?.[3], summary: m?.[4] ?? subject, issues };
    });
const logCommits = (...a) => parseCommits(git("log", "--no-merges", `--format=%h%x1f%s%x1f%b${SEP}`, ...a));

const SECTIONS = [
  ["Features", ["feat"]],
  ["Fixes", ["fix"]],
  ["Performance", ["perf"]],
  ["Security", ["security"]],
  ["Database", ["db"]],
  ["Maintenance", ["refactor", "style", "test", "build", "ci", "chore", "docs", "i18n", "revert", "other"]],
];

const line = (c) => {
  const scope = c.scope ? `**${c.scope}:** ` : "";
  const refs = [...new Set(c.issues)].join(", ");
  return `- ${c.breaking ? "**BREAKING** " : ""}${scope}${c.summary}${refs ? ` (${refs})` : ""} (${c.sha})`;
};

function draftEntry() {
  const commits = logCommits(...range, "--not", upstream);
  const syncs = git("log", "--first-parent", "--merges", "--format=%h%x1f%s", ...range)
    .split("\n")
    .filter((l) => /merge upstream/i.test(l))
    .map((l) => l.split("\x1f"));

  const date = tryGit("log", "-1", "--format=%cs", version) ?? new Date().toISOString().slice(0, 10);
  const out = [`## ${version} - ${date}`, "", `Upstream base: ${base}${from ? ` · Previous: ${from}` : ""}`, ""];
  out.push("### Highlights", "", HIGHLIGHTS_TODO, "");
  for (const [title, types] of SECTIONS) {
    const items = commits.filter((c) => types.includes(c.type));
    if (!items.length) continue;
    out.push(`### ${title}`, "", ...items.map(line), "");
  }
  if (syncs.length) {
    out.push("### Upstream syncs", "", ...syncs.map(([sha, s]) => `- ${s} (${sha})`), "");
  }
  return out.join("\n");
}

const semverKey = (tag) => tag.replace(/^v/, "").split(".").map(Number);
const bySemverDesc = (a, b) => {
  const [x, y] = [semverKey(a), semverKey(b)];
  return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
};

// Upstream releases this fork release brings in. The first fork release brings in its base.
function freshUpstreamTags() {
  const reachable = (ref) =>
    new Set(
      git("tag", "--merged", ref, "--list", "v*.*.*")
        .split("\n")
        .filter((t) => /^v\d+\.\d+\.\d+$/.test(t)),
    );
  if (!from) return [base];
  const before = reachable(from);
  return [...reachable(to)].filter((t) => !before.has(t)).sort(bySemverDesc);
}

// When the fork took the tag in: the first commit on monitored's own line that contains it.
function adoptedAt(tag) {
  const commits = git("log", "--first-parent", "--reverse", "--format=%H %cI", ...range).split("\n").filter(Boolean);
  const hit = commits.find((c) => tryGit("merge-base", "--is-ancestor", tag, c.split(" ")[0]) !== null);
  return hit ? hit.split(" ")[1] : git("log", "-1", "--format=%cI", tag);
}

function upstreamReleaseBody(tag) {
  try {
    return run("gh", ["release", "view", tag, "-R", UPSTREAM_REPO, "--json", "body", "-q", ".body"]);
  } catch {
    return null;
  }
}

// Upstream main commits this release merged that no upstream release carries yet.
function mergedUpstreamMain() {
  const syncPoint = tryGit("merge-base", to, upstream);
  if (!syncPoint) return [];
  const previousSync = from ? tryGit("merge-base", from, upstream) : null;
  const commits = logCommits(`${base}..${syncPoint}`, ...(previousSync ? ["--not", previousSync] : []));
  if (!commits.length) return [];
  const order = ["feat", "fix", "perf", "security", "db"];
  const notable = commits.filter((c) => order.includes(c.type)).sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
  const short = syncPoint.slice(0, 8);
  const out = [
    `Merged from upstream \`main\` up to [${short}](https://github.com/${UPSTREAM_REPO}/commit/${syncPoint}), not yet in an upstream release.`,
    "",
    ...notable.map((c) => qualifyUpstreamRefs(line(c))),
  ];
  const rest = commits.length - notable.length;
  if (rest) out.push(`- ${rest} maintenance commit${rest === 1 ? "" : "s"} (deps, i18n, docs, tests, CI)`);
  return out;
}

function upstreamSection() {
  const fresh = freshUpstreamTags();
  const merged = mergedUpstreamMain();
  if (!fresh.length && !merged.length) return [];
  const out = ["# Upstream changes in this release", ""];
  for (const tag of fresh) {
    out.push(`- Now based on upstream [BookOrbit ${tag.replace(/^v/, "")}](https://github.com/${forkRepo()}/releases/tag/${tag}); its release notes are there.`);
  }
  if (fresh.length && merged.length) out.push("");
  out.push(...merged, "");
  return out;
}

function mirrorBody() {
  const body = upstreamReleaseBody(version);
  const link = `https://github.com/${UPSTREAM_REPO}/releases/tag/${version}`;
  return [
    body ? qualifyUpstreamRefs(body).trim() : `See the [upstream release notes](${link}).`,
    "",
    "---",
    "",
    `Upstream BookOrbit ${version.replace(/^v/, "")}, mirrored from [${UPSTREAM_REPO}](${link}). Fork releases built on it are \`${version}-mN\`.`,
    "",
  ].join("\n");
}

// A backfilled tag points at a commit older than its changelog entry, so fall back to monitored.
function readChangelogSection() {
  const file = opt("changelog", null);
  const sources = file ? [readFileSync(file, "utf8")] : [tryGit("show", `${to}:CHANGELOG.fork.md`), tryGit("show", "origin/monitored:CHANGELOG.fork.md")];
  const heading = new RegExp(`^## ${version.replace(/\./g, "\\.")}( |$)`);
  for (const changelog of sources.filter(Boolean)) {
    const lines = changelog.split("\n");
    const start = lines.findIndex((l) => heading.test(l));
    if (start === -1) continue;
    const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
    return lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
  }
  throw new Error(`CHANGELOG.fork.md has no '## ${version}' section at ${to}${file ? ` or in ${file}` : " or origin/monitored"}`);
}

function splitHighlights(section) {
  const match = section.match(/^### Highlights[ \t]*\n([\s\S]*?)(?=^### |(?![\s\S]))/m);
  if (!match) return { highlights: null, rest: section.trim() };
  if (match[1].includes(HIGHLIGHTS_TODO) && !args.includes("--allow-draft")) throw new Error(`the ${version} highlights are still the placeholder`);
  return { highlights: match[1].trim() || null, rest: section.replace(match[0], "").trim() };
}

function releaseBody() {
  const { highlights, rest } = splitHighlights(readChangelogSection());
  const out = [];
  if (highlights) out.push(`# Highlights in ${version.replace(/^v/, "")}`, "", highlights, "");
  out.push(...upstreamSection());
  out.push(`# Fork changes in ${version.replace(/^v/, "")}`, "", rest.replace(/^### /gm, "## "), "");
  const image = opt("image", null);
  if (image) out.push("---", "", "**Docker**", "", "```bash", `docker pull ${image}`, "```", "");
  return out.join("\n");
}

try {
  if (upstreamMirror) process.stdout.write(mirrorBody());
  else if (args.includes("--fresh-upstream")) {
    const lines = [...freshUpstreamTags()].reverse().map((tag) => `${tag} ${git("rev-parse", `${tag}^{commit}`)} ${adoptedAt(tag)}`);
    process.stdout.write(lines.length ? `${lines.join("\n")}\n` : "");
  } else process.stdout.write(args.includes("--release-body") ? releaseBody() : draftEntry());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

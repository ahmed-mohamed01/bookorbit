#!/usr/bin/env node
// Fork release notes.
//   Draft a CHANGELOG.fork.md entry from commits that are on the fork but not upstream:
//     node scripts/fork/release-notes.mjs vX.Y.Z-mN [--from <ref>] [--to <ref>] [--upstream <ref>]
//   Build the GitHub Release body (upstream notes for the base, then the fork's changelog entry):
//     node scripts/fork/release-notes.mjs vX.Y.Z-mN --release-body [--to <ref>] [--changelog <file>]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const UPSTREAM_REPO = "bookorbit/bookorbit";
const args = process.argv.slice(2);
const version = args[0];
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

if (!version || !/^v\d+\.\d+\.\d+-m\d+$/.test(version)) {
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

if (!version.startsWith(`${base}-m`)) {
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

// Upstream releases this fork release brings in; when the base did not move, repeat the base's notes.
function upstreamReleaseTags() {
  const reachable = (ref) =>
    new Set(
      git("tag", "--merged", ref, "--list", "v*.*.*")
        .split("\n")
        .filter((t) => /^v\d+\.\d+\.\d+$/.test(t)),
    );
  const now = reachable(to);
  const before = from ? reachable(from) : new Set();
  const fresh = from ? [...now].filter((t) => !before.has(t)) : [];
  return (fresh.length ? fresh : [base]).sort(bySemverDesc);
}

function upstreamReleaseBody(tag) {
  try {
    return run("gh", ["release", "view", tag, "-R", UPSTREAM_REPO, "--json", "body", "-q", ".body"]);
  } catch {
    return null;
  }
}

function unreleasedUpstream() {
  const syncPoint = tryGit("merge-base", to, upstream);
  if (!syncPoint) return [];
  const commits = logCommits(`${base}..${syncPoint}`);
  if (!commits.length) return [];
  const order = ["feat", "fix", "perf", "security", "db"];
  const notable = commits.filter((c) => order.includes(c.type)).sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
  const short = syncPoint.slice(0, 8);
  const out = [
    `## Upstream changes after ${base}`,
    "",
    `Merged from upstream \`main\` at [${short}](https://github.com/${UPSTREAM_REPO}/commit/${syncPoint}), not yet in an upstream release. [Full compare](https://github.com/${UPSTREAM_REPO}/compare/${base}...${syncPoint}).`,
    "",
    ...notable.map((c) => qualifyUpstreamRefs(line(c))),
  ];
  const rest = commits.length - notable.length;
  if (rest) out.push(`- ${rest} maintenance commit${rest === 1 ? "" : "s"} (deps, i18n, docs, tests, CI)`);
  out.push("");
  return out;
}

function forkChangelogSection() {
  const file = opt("changelog", null);
  const changelog = file ? readFileSync(file, "utf8") : tryGit("show", `${to}:CHANGELOG.fork.md`);
  if (!changelog) throw new Error(`CHANGELOG.fork.md not found at ${to} (pass --changelog <file>)`);
  const lines = changelog.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^## ${version.replace(/\./g, "\\.")}( |$)`).test(l));
  if (start === -1) throw new Error(`CHANGELOG.fork.md has no '## ${version}' section at ${to}`);
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join("\n")
    .trim()
    .replace(/^### /gm, "## ");
}

function releaseBody() {
  const out = [];
  for (const tag of upstreamReleaseTags()) {
    const body = upstreamReleaseBody(tag);
    out.push(`# Upstream BookOrbit ${tag.replace(/^v/, "")}`, "");
    out.push(body ? qualifyUpstreamRefs(body).trim() : `See the [upstream release notes](https://github.com/${UPSTREAM_REPO}/releases/tag/${tag}).`);
    out.push("");
  }
  out.push(...unreleasedUpstream());
  out.push(`# Fork additions in ${version.replace(/^v/, "")}`, "", forkChangelogSection(), "");
  return out.join("\n");
}

try {
  process.stdout.write(args.includes("--release-body") ? releaseBody() : draftEntry());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

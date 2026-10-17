#!/usr/bin/env node
// Release step of a monitored push. Run on monitored, from a clean tree.
//   Draft the next CHANGELOG.fork.md entry and print the release body for approval:
//     node scripts/fork/release.mjs prepare [--version vX.Y.Z-mN] [--from <ref>]
//   Print the release body from the working-tree changelog (after editing the entry):
//     node scripts/fork/release.mjs preview [--version vX.Y.Z-mN]
//   Commit the entry, push monitored, then push a signed tag (Fork Release publishes it):
//     node scripts/fork/release.mjs publish vX.Y.Z-mN
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BRANCH = "monitored";
const CHANGELOG = "CHANGELOG.fork.md";
const HIGHLIGHTS_TODO = "<!-- highlights: write these before publishing -->";
const NOTES_SCRIPT = fileURLToPath(new URL("./release-notes.mjs", import.meta.url));
const VERSION_RE = /^v(\d+\.\d+\.\d+)-m(\d+)$/;

const [command, ...args] = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1];
};

const run = (cmd, a) => execFileSync(cmd, a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const runLoud = (cmd, a, env = process.env) => execFileSync(cmd, a, { stdio: "inherit", env });
const git = (...a) => run("git", a);
const tryGit = (...a) => {
  try {
    return git(...a);
  } catch {
    return null;
  }
};
const fail = (message) => {
  console.error(`release: ${message}`);
  process.exit(1);
};

process.chdir(git("rev-parse", "--show-toplevel"));

const repoSlug = () => {
  const m = git("remote", "get-url", "origin").match(/github\.com[:/](.+?)(?:\.git)?$/);
  if (!m) fail("origin is not a GitHub remote");
  return m[1];
};
const imageRef = (version) => `ghcr.io/${repoSlug().toLowerCase()}:${version.slice(1)}`;

function assertOnMonitored() {
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch !== BRANCH) fail(`run this on ${BRANCH} (currently on ${branch})`);
}

function dirtyPaths() {
  return [git("diff", "--name-only", "HEAD"), git("ls-files", "--others", "--exclude-standard")].join("\n").split("\n").filter(Boolean);
}

function assertOnlyChangelogDirty() {
  const others = dirtyPaths().filter((p) => p !== CHANGELOG);
  if (others.length) fail(`commit or set aside these first: ${others.join(", ")}`);
}

function fetchRefs() {
  git("fetch", "--quiet", "--no-tags", "upstream", "main");
  // Best effort: a local upstream tag that differs from upstream's is refused rather than clobbered.
  tryGit("fetch", "--quiet", "--no-tags", "upstream", "refs/tags/v*:refs/tags/v*");
  git("fetch", "--quiet", "--tags", "origin");
}

const remoteTagExists = (tag) => Boolean(tryGit("ls-remote", "--tags", "origin", `refs/tags/${tag}`));

function nextVersion(base) {
  const prefix = `${base}-m`;
  const committedChangelog = tryGit("show", `HEAD:${CHANGELOG}`) ?? "";
  const taken = [
    ...git("tag", "--list", `${prefix}*`).split("\n"),
    ...committedChangelog.split("\n").map((l) => l.match(/^## (v\S+)/)?.[1]),
  ]
    .map((v) => v?.match(VERSION_RE))
    .filter((m) => m && `v${m[1]}` === base)
    .map((m) => Number(m[2]));
  return `${prefix}${Math.max(0, ...taken) + 1}`;
}

function notes(version, extra) {
  return run("node", [NOTES_SCRIPT, version, ...extra]);
}

const highlightsOf = (section) => section.match(/^### Highlights[ \t]*\n([\s\S]*?)(?=^### |(?![\s\S]))/m)?.[1].trim() ?? null;

// Re-drafting refreshes the commit sections but keeps highlights already written for this version.
function insertEntry(changelog, version, entry) {
  const lines = changelog.split("\n");
  const own = lines.findIndex((l) => l.startsWith(`## ${version} `) || l === `## ${version}`);
  if (own !== -1) {
    const end = lines.findIndex((l, i) => i > own && /^## /.test(l));
    const kept = highlightsOf(lines.slice(own, end === -1 ? undefined : end).join("\n"));
    if (kept && !kept.includes(HIGHLIGHTS_TODO)) entry = entry.replace(HIGHLIGHTS_TODO, kept);
    lines.splice(own, (end === -1 ? lines.length : end) - own);
  }
  const first = lines.findIndex((l) => /^## v/.test(l));
  lines.splice(first === -1 ? lines.length : first, 0, ...entry.trimEnd().split("\n"), "");
  return lines.join("\n");
}

function topChangelogVersion() {
  return readFileSync(CHANGELOG, "utf8").match(/^## (v\S+)/m)?.[1] ?? null;
}

function preview(version) {
  const body = notes(version, ["--release-body", "--allow-draft", "--changelog", CHANGELOG, "--image", imageRef(version)]);
  console.log(`===== GitHub Release: BookOrbit ${version.slice(1)} =====\n`);
  console.log(body);
}

function prepare() {
  assertOnMonitored();
  assertOnlyChangelogDirty();
  fetchRefs();
  const base = git("describe", "--tags", "--abbrev=0", "--exclude", "*-m*", "HEAD");
  const previous = tryGit("describe", "--tags", "--abbrev=0", "--match", "v*-m*", "HEAD");
  const from = opt("from") ?? previous;
  if (!from) fail("no earlier fork tag is reachable from HEAD; pass --from <ref>");
  const count = Number(git("rev-list", "--count", `${from}..HEAD`));
  if (!count) {
    console.log(`release: nothing new since ${from}, no release to cut`);
    return;
  }
  const version = opt("version") ?? nextVersion(base);
  if (!VERSION_RE.test(version)) fail(`${version} is not vX.Y.Z-mN`);
  if (tryGit("rev-parse", "--verify", "--quiet", `refs/tags/${version}`) || remoteTagExists(version)) fail(`${version} is already tagged`);

  const entry = notes(version, ["--from", from, "--to", "HEAD"]);
  writeFileSync(CHANGELOG, insertEntry(readFileSync(CHANGELOG, "utf8"), version, entry));
  console.log(`release: drafted ${version} in ${CHANGELOG} (${count} commits since ${from}, base ${base})`);
  console.log(`release: replace the highlights placeholder, then run preview and publish\n`);
  preview(version);
}

function publish() {
  const version = args[0];
  if (!version || !VERSION_RE.test(version)) fail("usage: release.mjs publish vX.Y.Z-mN");
  assertOnMonitored();
  assertOnlyChangelogDirty();

  const changelog = readFileSync(CHANGELOG, "utf8");
  if (!new RegExp(`^## ${version.replace(/\./g, "\\.")}( |$)`, "m").test(changelog)) fail(`${CHANGELOG} has no ${version} entry`);
  if (changelog.includes(HIGHLIGHTS_TODO)) fail(`write the ${version} highlights first`);
  if (remoteTagExists(version)) fail(`${version} is already on origin`);
  notes(version, ["--release-body", "--changelog", CHANGELOG]);

  if (dirtyPaths().includes(CHANGELOG)) {
    git("add", CHANGELOG);
    runLoud("git", ["commit", "-m", `docs(release): ${version}`]);
  }

  // The pre-push gate (verify:fast) runs server ESLint, which runs out of memory at the default heap.
  const env = { ...process.env, NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--max-old-space-size=8192" };
  runLoud("git", ["push", "origin", BRANCH], env);

  const head = git("rev-parse", "HEAD");
  const tagged = tryGit("rev-parse", "--verify", "--quiet", `refs/tags/${version}^{commit}`);
  if (tagged && tagged !== head) fail(`local tag ${version} points at ${tagged.slice(0, 8)}, not HEAD`);
  if (!tagged) runLoud("git", ["tag", "-s", version, "-m", `BookOrbit ${version.slice(1)}`]);
  // The branch push just ran the gate on this exact commit.
  runLoud("git", ["push", "--no-verify", "origin", `refs/tags/${version}`]);

  console.log(`\nrelease: pushed ${version}; Fork Release publishes https://github.com/${repoSlug()}/releases/tag/${version}`);
}

try {
  if (command === "prepare") prepare();
  else if (command === "preview") preview(opt("version") ?? topChangelogVersion() ?? fail(`${CHANGELOG} has no entry`));
  else if (command === "publish") publish();
  else fail("usage: release.mjs prepare|preview|publish (see the header of this file)");
} catch (error) {
  fail(error instanceof Error ? (error.stderr?.toString().trim() || error.message) : String(error));
}

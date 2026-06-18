/**
 * Lint a "What's New" Highlights section before (or after) publishing: static, no network.
 * Uses the same parser the app uses, so a clean lint means it will parse correctly.
 *
 *   pnpm whats-new:lint path/to/notes.md      # lint a local markdown file (before pasting)
 *   pnpm whats-new:lint --tag v3.2.0          # fetch + lint a published release
 *   pnpm whats-new:lint notes.md --strict     # treat warnings as failures too
 *
 * Exits 1 if there are errors (or warnings under --strict), so it can gate CI.
 */
import { readFileSync } from 'node:fs';

import { lintHighlights } from '../modules/release-notes/highlights.lint';

function loadEnv(): Record<string, string> {
  try {
    const raw = readFileSync('.env', 'utf8');
    const out: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !line.startsWith('#')) out[m[1]] = m[2].trim();
    }
    return out;
  } catch {
    return {};
  }
}

async function resolveBody(args: string[]): Promise<{ source: string; body: string }> {
  const tagIdx = args.indexOf('--tag');
  if (tagIdx !== -1) {
    const tag = args[tagIdx + 1];
    if (!tag) throw new Error('--tag requires a value, e.g. --tag v3.2.0');
    const env = { ...process.env, ...loadEnv() };
    const repo = env.GITHUB_RELEASES_REPO ?? 'bookorbit/bookorbit';
    const token = env.GITHUB_RELEASES_TOKEN;
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, {
      headers: { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status} for ${repo}@${tag}`);
    const body = ((await res.json()) as { body: string | null }).body ?? '';
    return { source: `${repo}@${tag}`, body };
  }

  const file = args.find((a) => !a.startsWith('--'));
  if (!file) throw new Error('Provide a file path or --tag <tag>. See: pnpm whats-new:lint --help');
  return { source: file, body: readFileSync(file, 'utf8') };
}

function printHelp(): void {
  console.log(
    [
      'Usage: pnpm whats-new:lint <file.md> | --tag <tag> [--strict]',
      '',
      'Validates a Highlights section with the same parser the app uses',
      '(no network for a file; one GitHub fetch for --tag).',
      '',
      '  <file.md>      lint a local markdown file',
      '  --tag <tag>    fetch + lint a release by tag',
      '  --strict       treat warnings as failures too',
      '',
      'Env (server/.env): GITHUB_RELEASES_REPO, GITHUB_RELEASES_TOKEN',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.length === 0) {
    printHelp();
    process.exit(args.length === 0 ? 1 : 0);
  }
  const strict = args.includes('--strict');

  const { source, body } = await resolveBody(args);
  const { errors, warnings, highlightCount } = lintHighlights(body);

  console.log(`\nLinting Highlights · ${source}\n${'─'.repeat(56)}`);
  for (const e of errors) console.log(`  ✗ ERROR   ${e}`);
  for (const w of warnings) console.log(`  ⚠ WARN    ${w}`);
  console.log(`${'─'.repeat(56)}`);
  console.log(`${highlightCount} highlight(s) · ${errors.length} error(s) · ${warnings.length} warning(s)`);

  const failed = errors.length > 0 || (strict && warnings.length > 0);
  console.log(failed ? '✗ FAILED' : '✓ OK');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});

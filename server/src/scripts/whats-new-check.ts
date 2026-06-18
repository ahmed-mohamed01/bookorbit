/**
 * One-stop check for a release's "What's New" highlights: lint, then preview.
 *
 *   pnpm whats-new:check <tag>      # e.g. pnpm whats-new:check v4.5.0
 *
 * Runs whats-new:lint --tag <tag> followed by whats-new:preview <tag>, sharing
 * GITHUB_RELEASES_REPO / GITHUB_RELEASES_TOKEN from server/.env. Exits non-zero
 * if the lint fails; the preview is informational and always runs.
 */
import { execFileSync } from 'node:child_process';

function printHelp(): void {
  console.log(
    [
      'Usage: pnpm whats-new:check <tag>',
      '',
      'Lints, then previews, the release for <tag> (runs whats-new:lint --tag then',
      'whats-new:preview). Exits non-zero if the lint fails.',
      '',
      'Env (server/.env): GITHUB_RELEASES_REPO, GITHUB_RELEASES_TOKEN',
    ].join('\n'),
  );
}

const tag = process.argv[2];
if (tag === '--help' || tag === '-h') {
  printHelp();
  process.exit(0);
}
if (!tag || tag.startsWith('-')) {
  printHelp();
  process.exit(1);
}

let lintOk = true;
try {
  execFileSync('tsx', ['src/scripts/whats-new-lint.ts', '--tag', tag], { stdio: 'inherit' });
} catch {
  lintOk = false;
}

console.log('');

try {
  execFileSync('tsx', ['src/scripts/whats-new-preview.ts', tag], { stdio: 'inherit' });
} catch {
  // The preview is informational; do not let its exit status mask the lint result.
}

process.exit(lintOk ? 0 : 1);

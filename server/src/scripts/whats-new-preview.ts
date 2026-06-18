/**
 * Preview exactly what BookOrbit's "What's New" will render for a repo's releases,
 * using the SAME parser + media content-type probe the app uses (no drift).
 *
 *   pnpm whats-new:preview                 # all releases on page 1 of the configured repo
 *   pnpm whats-new:preview v3.2.0          # just that tag
 *   pnpm whats-new:preview --repo owner/r  # override the repo
 *
 * Reads GITHUB_RELEASES_REPO / GITHUB_RELEASES_TOKEN / APP_VERSION from server/.env.
 */
import { readFileSync } from 'node:fs';

import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import type { AppSettingsService } from '../modules/app-settings/app-settings.service';
import { ReleaseNotesService } from '../modules/release-notes/release-notes.service';

Logger.overrideLogger(false);

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

async function checkReachable(url: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' } });
    const type = (res.headers.get('content-type') ?? '').split(';')[0];
    return { ok: res.status >= 200 && res.status < 300, detail: `${res.status} ${type}` };
  } catch {
    return { ok: false, detail: 'unreachable' };
  }
}

function printHelp(): void {
  console.log(
    [
      'Usage: pnpm whats-new:preview [tag] [--repo owner/name]',
      '',
      "Renders exactly what the app will show for the configured repo's releases,",
      'and probes each media URL for reachability.',
      '',
      '  [tag]         preview a single release (e.g. v4.5.0); omit for all on page 1',
      '  --repo o/n    override the source repo',
      '',
      'Env (server/.env): GITHUB_RELEASES_REPO, GITHUB_RELEASES_TOKEN, APP_VERSION',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }
  const env = { ...process.env, ...loadEnv() };
  let repoOverride: string | undefined;
  let tag: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--repo') repoOverride = args[++i];
    else tag = args[i];
  }

  const repo = repoOverride ?? env.GITHUB_RELEASES_REPO ?? 'bookorbit/bookorbit';
  const token = env.GITHUB_RELEASES_TOKEN;
  const version = env.APP_VERSION;

  const config = {
    get: (key: string) =>
      key === 'app.githubReleasesRepo' ? repo : key === 'app.githubReleasesToken' ? token : key === 'app.version' ? version : undefined,
  } as unknown as ConfigService;
  const appSettings = { isUpdateCheckEnabled: () => Promise.resolve(true) } as unknown as AppSettingsService;
  const service = new ReleaseNotesService(config, appSettings);

  console.log(`\nWhat's New preview  ·  repo=${repo}${tag ? `  tag=${tag}` : ''}\n${'─'.repeat(60)}`);

  const { releases } = await service.getAll(1);
  const shown = tag ? releases.filter((r) => r.version === tag) : releases;

  if (shown.length === 0) {
    if (releases.length === 0) {
      const probe = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=1`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      }).catch(() => null);
      console.log(`No releases returned. GitHub API status: ${probe?.status ?? 'unreachable'} (check GITHUB_RELEASES_REPO / token).`);
    } else {
      console.log(`No release "${tag}" on page 1 (only the 30 most recent are checked).`);
    }
    return;
  }

  let warnings = 0;
  for (const rel of shown) {
    console.log(`\n■ ${rel.version}   ${rel.date?.slice(0, 10) ?? ''}`);

    if (rel.highlights.length === 0) {
      console.log('  ⚠ 0 highlights parsed - popup is skipped for this version (only the changelog shows).');
      console.log('    If you wrote a "## Highlights" section, check the heading spelling and that bullets start with "- ".');
      warnings++;
    }

    for (const h of rel.highlights) {
      console.log(`  • ${h.icon ? `[${h.icon}]` : '[default icon]'}  ${h.title}`);
      if (h.body) console.log(`      ${h.body.length > 96 ? `${h.body.slice(0, 96)}…` : h.body}`);
      else {
        console.log('      ⚠ no body text');
        warnings++;
      }

      for (const m of h.media) {
        const { ok, detail } = await checkReachable(m.url);
        console.log(`      ${ok ? '✓' : '⚠'} ${m.type}: ${detail}  ${m.url}`);
        if (!ok) warnings++;
      }
    }
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(warnings === 0 ? '✓ No problems detected - this is what BookOrbit will render.' : `⚠ ${warnings} warning(s) above.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});

/**
 * Captures one author's RAW provider payloads into the reconcile acceptance fixture format, driving
 * the real bibliography providers so a fixture stays a faithful replay of a live refresh.
 *
 * Usage: pnpm tsx --env-file-if-exists=.env src/scripts/capture-monitored-fixture.ts "Brandon Sanderson" brandon_sanderson
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Logger } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { createPostgresClientConfig } from '../db/postgres-connection-config';
import * as schema from '../db/schema';
import { HardcoverClient } from '../modules/metadata-fetch/providers/hardcover/hardcover.client';
import { ProviderConfigService } from '../modules/metadata-preferences/provider-config.service';
import { AudibleBibliographyProvider } from '../modules/monitored/providers/audible-bibliography.provider';
import type { AuthorBibliographyProvider } from '../modules/monitored/providers/author-bibliography-provider';
import { GoodreadsBibliographyProvider } from '../modules/monitored/providers/goodreads-bibliography.provider';
import { HardcoverBibliographyProvider } from '../modules/monitored/providers/hardcover-bibliography.provider';
import type { Observation, ObservationSource } from '../modules/monitored/reconcile/observation.types';

// Run from the server workspace root, matching the other scripts here.
const FIXTURE_DIR = join(process.cwd(), 'src', 'modules', 'monitored', 'reconcile', '__fixtures__');

// Hardcover's raw row is the unwrapped book, so the contributor role that decides wrong_contributor
// survives only on the observation. Re-attaching it produces the flattened shape
// mapHardcoverObservations reads back, which makes the fixture a lossless round trip.
function rawRows(observations: Observation[], source: ObservationSource): unknown[] {
  return observations
    .filter((observation) => observation.source === source)
    .map((observation) =>
      source === 'hardcover' ? { ...(observation.raw as Record<string, unknown>), contribution: observation.role } : observation.raw,
    );
}

async function main(): Promise<void> {
  const [authorName, slug] = process.argv.slice(2);
  if (!authorName || !slug) throw new Error('Usage: capture-monitored-fixture.ts "<author name>" <fixture-slug>');

  const logger = new Logger('capture-monitored-fixture');
  const startedAt = Date.now();
  logger.log(`[monitored.fixture_capture] [start] slug=${slug} authorName="${authorName}" - fixture capture started`);

  const pool = new Pool(createPostgresClientConfig(process.env.DATABASE_URL ?? '', { max: 2 }));
  const providerConfig = new ProviderConfigService(drizzle(pool, { schema }));
  const config = await providerConfig.getConfig();
  const providers: AuthorBibliographyProvider[] = [
    new HardcoverBibliographyProvider(new HardcoverClient()),
    new GoodreadsBibliographyProvider(),
    new AudibleBibliographyProvider(),
  ];

  try {
    const observations: Observation[] = [];
    let hardcoverAuthorId: number | null = null;
    for (const provider of providers) {
      const authorRef = await provider.resolveAuthor(authorName, config);
      if (!authorRef) {
        logger.warn(
          `[monitored.fixture_capture] [fail] slug=${slug} source=${provider.source} durationMs=${Date.now() - startedAt} errorClass=AuthorNotResolved error="provider did not resolve the author" - source skipped`,
        );
        continue;
      }
      if (provider.source === 'hardcover') hardcoverAuthorId = Number(authorRef.id);
      observations.push(...(await provider.fetchObservations(authorRef, config)));
    }

    const fixture = {
      name: authorName,
      slug,
      fetchedAt: new Date().toISOString(),
      hardcover: { author: { id: hardcoverAuthorId, name: authorName }, identityExact: true, books: rawRows(observations, 'hardcover') },
      goodreads: { rows: rawRows(observations, 'goodreads') },
      audible: { products: rawRows(observations, 'audible') },
    };
    const target = join(FIXTURE_DIR, `${slug}.json`);
    writeFileSync(target, `${JSON.stringify(fixture, null, 2)}\n`);
    logger.log(
      `[monitored.fixture_capture] [end] slug=${slug} durationMs=${Date.now() - startedAt} hardcover=${fixture.hardcover.books.length} goodreads=${fixture.goodreads.rows.length} audible=${fixture.audible.products.length} - fixture capture completed`,
    );
  } finally {
    await pool.end();
  }
}

void main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);

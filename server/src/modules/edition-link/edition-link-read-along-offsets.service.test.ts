import { drizzle } from 'drizzle-orm/node-postgres';

import type { ReadAlongOffsetsRecord } from '../book/read-along-offsets-store';
import { EditionLinkReadAlongOffsetsService } from './edition-link-read-along-offsets.service';

const RECORD: ReadAlongOffsetsRecord = {
  readAlongFileId: 30,
  audioBookId: 5,
  narrationSignature: [{ audioHref: 'Audio/00001-00001.mp4', durationSeconds: 195.7 }],
  audioSignature: [{ fileId: 11, durationSeconds: 196 }],
  status: 'ready',
  source: 'match',
  offsets: [{ audioHref: 'Audio/00001-00001.mp4', startSeconds: 0, durationSeconds: 195.7 }],
  mismatch: null,
};

function makeService(rows: unknown[][] = []) {
  const query = vi.fn().mockResolvedValue({ rows, fields: [], rowCount: rows.length });
  const db = drizzle({ client: { query } as never });
  return { service: new EditionLinkReadAlongOffsetsService(db as never), query };
}

function sentQuery(query: ReturnType<typeof vi.fn>): { text: string; values: unknown[] } {
  const [config, values] = query.mock.calls[0]!;
  return { text: typeof config === 'string' ? config : config.text, values };
}

describe('EditionLinkReadAlongOffsetsService', () => {
  it('finds the record for one read-along file and audiobook', async () => {
    const { service, query } = makeService([[30, 5, RECORD.narrationSignature, RECORD.audioSignature, 'ready', 'match', RECORD.offsets, null]]);

    await expect(service.find(30, 5)).resolves.toEqual(RECORD);

    const { text, values } = sentQuery(query);
    expect(text).toContain('from "read_along_narration_offsets"');
    expect(text).toMatch(/"read_along_file_id" = \$1 and "read_along_narration_offsets"\."audio_book_id" = \$2/);
    expect(values).toEqual([30, 5, 1]);
  });

  it('returns null when the pair was never matched', async () => {
    const { service } = makeService([]);

    await expect(service.find(30, 5)).resolves.toBeNull();
  });

  it('upserts on the read-along file and audiobook pair', async () => {
    const { service, query } = makeService();

    await service.save({
      ...RECORD,
      status: 'mismatch',
      offsets: null,
      mismatch: { narrationFile: 2, narrationSeconds: 60, chapter: 3, chapterSeconds: 90 },
    });

    const { text, values } = sentQuery(query);
    expect(text).toContain('insert into "read_along_narration_offsets"');
    expect(text).toContain('on conflict ("read_along_file_id","audio_book_id") do update set');
    expect(text).toContain('"updated_at" = now()');
    expect(values).toContain(30);
    expect(values).toContain('mismatch');
    expect(values).toContain(JSON.stringify({ narrationFile: 2, narrationSeconds: 60, chapter: 3, chapterSeconds: 90 }));
  });

  it('deletes only the given pair', async () => {
    const { service, query } = makeService();

    await service.delete(30, 5);

    const { text, values } = sentQuery(query);
    expect(text).toMatch(/^delete from "read_along_narration_offsets" where/);
    expect(values).toEqual([30, 5]);
  });
});

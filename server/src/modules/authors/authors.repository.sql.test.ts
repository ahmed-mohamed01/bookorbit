import { drizzle } from 'drizzle-orm/node-postgres';
import { describe, expect, it, vi } from 'vitest';

import { AuthorsRepository } from './authors.repository';

describe('AuthorsRepository generated SQL', () => {
  it('correlates the cover subquery to the outer author in a single-table select', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const repository = new AuthorsRepository(drizzle({ client: { query } } as never) as never);

    await repository.findCoverBookIds([4], [1]);

    const [statement] = query.mock.calls[0] as [{ text: string }];
    expect(statement.text).toContain('cba.author_id = "authors"."id"');
  });
});

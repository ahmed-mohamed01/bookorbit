import { drizzle } from 'drizzle-orm/node-postgres';

import { WebSerialsJobPageRepository } from './web-serials-job-page.repository';

describe('WebSerialsJobPageRepository', () => {
  it('ranks manager and owner lanes by the worker order before filtering to the viewer', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const repository = new WebSerialsJobPageRepository(drizzle({ client: { query } as never }));
    await repository.pageForJobs({
      view: 'queue',
      owner: { id: 7 },
      after: null,
      cutoffAt: new Date(),
      typeIndex: 11,
      limit: 51,
    });
    const [statement, params] = query.mock.calls[0]!;
    expect(statement.text).toContain('row_number() over (order by q.queue_order, q.id)');
    expect(statement.text).toContain('row_number() over (partition by q.user_id order by q.queue_order, q.id)');
    expect(statement.text).toContain('count(*) over (partition by q.user_id) as own_lane_size');
    expect(params).toContain(7);
    expect(params).toContain(51);
  });
});

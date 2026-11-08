import { BookConsolidationParticipants, type ConsolidationTx } from './book-consolidation-participants';

const tx = { marker: 'tx' } as unknown as ConsolidationTx;

describe('BookConsolidationParticipants', () => {
  it('runs participants in registration order, one at a time, on the one transaction', async () => {
    const registry = new BookConsolidationParticipants();
    const events: string[] = [];
    const moveBookRows = vi.fn(async (_tx: ConsolidationTx, keptBookId: number, sourceBookId: number) => {
      events.push(`first:start:${keptBookId}:${sourceBookId}`);
      await Promise.resolve();
      events.push('first:end');
    });
    registry.register({ name: 'first', moveBookRows });
    registry.register({
      name: 'second',
      moveBookRows: () => {
        events.push('second');
        return Promise.resolve();
      },
    });

    await registry.moveAll(tx, 1, 2);

    expect(events).toEqual(['first:start:1:2', 'first:end', 'second']);
    expect(moveBookRows.mock.calls[0][0]).toBe(tx);
  });

  it('propagates an error and runs nothing after it, so the merge rolls back', async () => {
    const registry = new BookConsolidationParticipants();
    const failure = new Error('boom');
    const after = vi.fn();
    registry.register({ name: 'bad', moveBookRows: () => Promise.reject(failure) });
    registry.register({ name: 'after', moveBookRows: after });

    await expect(registry.moveAll(tx, 1, 2)).rejects.toBe(failure);
    expect(after).not.toHaveBeenCalled();
  });

  it('does nothing with no participants', async () => {
    await expect(new BookConsolidationParticipants().moveAll(tx, 1, 2)).resolves.toBeUndefined();
  });
});

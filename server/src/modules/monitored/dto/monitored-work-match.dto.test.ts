import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { SetMonitoredWorkMatchDto } from './monitored-work-match.dto';

function errorsFor(payload: Record<string, unknown>) {
  return validate(plainToInstance(SetMonitoredWorkMatchDto, payload));
}

describe('SetMonitoredWorkMatchDto', () => {
  it.each([[{ decision: 'link', bookId: 31 }], [{ decision: 'reject', bookId: 31 }], [{ decision: 'automatic' }]])('accepts %j', async (payload) => {
    await expect(errorsFor(payload)).resolves.toHaveLength(0);
  });

  it.each([
    ['a link without a book', { decision: 'link' }],
    ['a rejection without a book', { decision: 'reject' }],
    ['an unknown decision', { decision: 'maybe', bookId: 31 }],
    ['a book id that is not an int4', { decision: 'link', bookId: 2147483648 }],
    ['a book id of zero', { decision: 'reject', bookId: 0 }],
  ])('rejects %s', async (_label, payload) => {
    await expect(errorsFor(payload)).resolves.not.toHaveLength(0);
  });
});

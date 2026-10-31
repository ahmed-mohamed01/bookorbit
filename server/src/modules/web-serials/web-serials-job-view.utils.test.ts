import { describe, expect, it } from 'vitest';
import { Permission } from '@bookorbit/types';
import type { RequestUser } from '../../common/types/request-user';
import type { WebSerialJobWithLibrary } from './web-serials.repository';
import { toWebSerialJob } from './web-serials-job-view.utils';

const row = {
  status: 'queued',
  queuePosition: 3,
  ownerQueuePosition: 1,
  engineState: {},
  createdAt: new Date(),
} as WebSerialJobWithLibrary;
const owner = { id: 1, isSuperuser: false, permissions: [] } as unknown as RequestUser;

describe('queue move eligibility', () => {
  it('uses the owner position even when other users are ahead globally', () => {
    expect(toWebSerialJob(row, owner).canMoveToTop).toBe(false);
    expect(toWebSerialJob({ ...row, ownerQueuePosition: 2 }, owner).canMoveToTop).toBe(true);
  });
  it.each([
    { ...owner, isSuperuser: true },
    { ...owner, permissions: [Permission.ManageAppSettings] },
  ])('uses the global position for administrators, including on their own queue', (admin) => {
    expect(toWebSerialJob(row, admin).canMoveToTop).toBe(true);
    expect(toWebSerialJob({ ...row, queuePosition: 1 }, admin).canMoveToTop).toBe(false);
    expect(toWebSerialJob({ ...row, status: 'paused' }, admin).canMoveToTop).toBe(false);
  });
});

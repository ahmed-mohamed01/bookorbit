import type { RequestUser } from '../../common/types/request-user';
import type { JobSource } from '../jobs/job-source';
import { JobSourceRegistry } from '../jobs/job-source.registry';
import { ForkJobReorderService } from './fork-job-reorder.service';

const user = { id: 7 } as RequestUser;

describe('ForkJobReorderService', () => {
  it('skips job types without a relative reorder action', async () => {
    const registry = new JobSourceRegistry();
    registry.register({ type: 'story-guide' } as JobSource);
    const service = new ForkJobReorderService(registry);
    await expect(service.reorder(user, { id: 'story-guide:8', targetId: 'story-guide:4', place: 'after' })).resolves.toEqual({
      outcome: 'skipped',
      status: null,
    });
  });

  it('passes native IDs, drop position and the source viewer to the adapter', async () => {
    const registry = new JobSourceRegistry();
    const access = { own: true, all: false };
    const reorderTo = vi.fn().mockResolvedValue({ outcome: 'done', status: 'queued' });
    registry.register({ type: 'web-serial', access: () => access, reorderTo } as JobSource);
    const service = new ForkJobReorderService(registry);
    await expect(service.reorder(user, { id: 'web-serial:8', targetId: 'web-serial:4', place: 'after' })).resolves.toEqual({
      outcome: 'done',
      status: 'queued',
    });
    expect(reorderTo).toHaveBeenCalledWith('8', '4', 'after', { user, access });
  });
});

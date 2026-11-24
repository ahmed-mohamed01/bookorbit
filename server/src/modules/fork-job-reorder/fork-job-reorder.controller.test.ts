import { ValidationPipe } from '@nestjs/common';
import { JOBS_VIEW_PERMISSIONS } from '@bookorbit/types';

import { INTERACTIVE_ONLY_KEY } from '../../common/decorators/api-key-policy.decorator';
import { ANY_PERMISSION_KEY } from '../../common/decorators/require-any-permission.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { JobReorderDto } from './dto/job-reorder.dto';
import { ForkJobReorderController } from './fork-job-reorder.controller';

const drop = { id: 'web-serial:8', targetId: 'web-serial:4', place: 'before' };

describe('ForkJobReorderController', () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
  const metadata = { type: 'body' as const, metatype: JobReorderDto };

  it.each([{ id: 'bad' }, { id: 8 }, { targetId: 'web-serial:bad/id' }, { targetId: 'edition-sync:4' }, { place: 'middle' }, { extra: true }])(
    'rejects an invalid drop (%j)',
    async (invalid) => {
      await expect(pipe.transform({ ...drop, ...invalid }, metadata)).rejects.toMatchObject({ status: 400 });
    },
  );

  it('accepts a valid drop for the current user and uses the Jobs access rules', async () => {
    const user = { id: 7 } as RequestUser;
    const dto = (await pipe.transform(drop, metadata)) as JobReorderDto;
    const service = { reorder: vi.fn().mockResolvedValue({ outcome: 'done', status: 'queued' }) };
    const controller = new ForkJobReorderController(service as never);
    await expect(controller.reorder(dto, user)).resolves.toEqual({ outcome: 'done', status: 'queued' });
    expect(service.reorder).toHaveBeenCalledWith(user, drop);
    expect(Reflect.getMetadata('path', ForkJobReorderController)).toBe('fork/jobs');
    expect(Reflect.getMetadata('path', controller.reorder)).toBe('reorder');
    expect(Reflect.getMetadata(INTERACTIVE_ONLY_KEY, ForkJobReorderController)).toBe(true);
    expect(Reflect.getMetadata(ANY_PERMISSION_KEY, controller.reorder)).toEqual(JOBS_VIEW_PERMISSIONS);
  });
});

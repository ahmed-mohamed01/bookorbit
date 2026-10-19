import 'reflect-metadata';

import { validate } from 'class-validator';

import { CreateBatchGrabDto } from './create-batch-grab.dto';

function dto(unitIndexes: number[]): CreateBatchGrabDto {
  return Object.assign(new CreateBatchGrabDto(), {
    sourceRequestId: 1,
    indexerId: 1,
    releaseGuid: 'guid-1',
    downloadClientId: 1,
    unitIndexes,
  });
}

describe('CreateBatchGrabDto', () => {
  it('accepts a single book so one more volume can be added to a torrent already in the client', async () => {
    await expect(validate(dto([0]))).resolves.toEqual([]);
  });

  it('refuses an empty selection', async () => {
    const errors = await validate(dto([]));
    expect(errors.map((error) => error.property)).toEqual(['unitIndexes']);
  });
});

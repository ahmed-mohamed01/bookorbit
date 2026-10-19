import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsInt, IsNotEmpty, IsString, MaxLength, Min } from 'class-validator';
import { MAX_BATCH_UNITS, MAX_INDEXER_RELEASE_GUID_LENGTH, type CreateBatchGrabPayload } from '@bookorbit/types';

export class CreateBatchGrabDto implements CreateBatchGrabPayload {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  sourceRequestId!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  indexerId!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_INDEXER_RELEASE_GUID_LENGTH)
  releaseGuid!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  downloadClientId!: number;

  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(MAX_BATCH_UNITS)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(0, { each: true })
  unitIndexes!: number[];
}

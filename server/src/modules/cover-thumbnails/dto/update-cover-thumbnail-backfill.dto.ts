import { IsBoolean } from 'class-validator';
import type { UpdateCoverThumbnailBackfillPayload } from '@bookorbit/types';

export class UpdateCoverThumbnailBackfillDto implements UpdateCoverThumbnailBackfillPayload {
  @IsBoolean()
  enabled!: boolean;
}

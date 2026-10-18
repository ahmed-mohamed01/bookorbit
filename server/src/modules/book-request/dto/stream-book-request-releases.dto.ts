import { Type } from 'class-transformer';
import { IsBoolean, IsOptional, ValidateNested } from 'class-validator';
import type { StreamBookRequestReleasesPayload } from '@bookorbit/types';
import { SearchBookRequestReleasesDto } from './search-book-request-releases.dto';

export class StreamBookRequestReleasesDto implements StreamBookRequestReleasesPayload {
  @IsOptional()
  @IsBoolean()
  refresh?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => SearchBookRequestReleasesDto)
  overrides?: SearchBookRequestReleasesDto;
}

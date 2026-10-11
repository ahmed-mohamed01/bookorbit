import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';

export class ForBookQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  counterpartId?: number;
}

import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

export class BuildAlignmentQueryDto {
  // Accept only the string booleans the client sends ('true'/'false'); anything else stays a string and
  // fails IsBoolean, so a typo like ?force=tru is a 400 rather than a silent (and surprising) no-op.
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  force?: boolean;
}

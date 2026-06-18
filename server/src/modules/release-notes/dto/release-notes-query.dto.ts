import { IsNumberString, IsOptional, IsString, MaxLength } from 'class-validator';

export class ReleaseNotesQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  since?: string;

  @IsOptional()
  @IsNumberString()
  @MaxLength(10)
  page?: string;
}

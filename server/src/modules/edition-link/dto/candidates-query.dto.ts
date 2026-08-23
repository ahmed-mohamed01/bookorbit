import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CandidatesQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;
}

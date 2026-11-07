import { IsOptional, IsString } from 'class-validator';

export class PortraitReadQueryDto {
  @IsOptional()
  @IsString()
  t?: string;
}

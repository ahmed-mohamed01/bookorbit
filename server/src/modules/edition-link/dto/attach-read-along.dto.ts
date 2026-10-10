import { IsInt, Min } from 'class-validator';

export class AttachReadAlongDto {
  @IsInt()
  @Min(1)
  readAlongBookId: number;
}

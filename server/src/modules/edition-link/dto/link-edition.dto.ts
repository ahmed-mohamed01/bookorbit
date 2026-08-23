import { IsInt, Min } from 'class-validator';

export class LinkEditionDto {
  @IsInt()
  @Min(1)
  counterpartId: number;
}

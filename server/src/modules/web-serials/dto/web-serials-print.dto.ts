import { PickType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { MAX_INDEXER_RELEASE_GUID_LENGTH, type WebSerialDownloadInput } from '@bookorbit/types';
import {
  ValidateIf,
  IsOptional,
  ValidateNested,
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsString,
  IsUrl,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { WEB_SERIAL_MAX_PUBLISHED_VOLUMES, type WebSerialPrintSeriesInput, type RequestWebSerialVolumesInput } from '@bookorbit/types';

export class WebSerialPrintSeriesDto implements WebSerialPrintSeriesInput {
  @IsString()
  @Length(1, 500)
  title!: string;

  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  altTitles!: string[];

  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  authors!: string[];

  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  url!: string;

  @IsInt()
  @Min(1)
  @Max(WEB_SERIAL_MAX_PUBLISHED_VOLUMES)
  volumeCount!: number;
}

export class RequestWebSerialVolumesDto extends WebSerialPrintSeriesDto implements RequestWebSerialVolumesInput {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(WEB_SERIAL_MAX_PUBLISHED_VOLUMES)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(WEB_SERIAL_MAX_PUBLISHED_VOLUMES, { each: true })
  volumes!: number[];
}

export class WebSerialSuggestionQueryDto {
  @IsString()
  @Length(1, 500)
  title!: string;

  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  authors!: string[];
}

export class WebSerialSuggestionDto extends PickType(WebSerialPrintSeriesDto, ['title', 'altTitles', 'volumeCount'] as const) {
  @IsOptional()
  @ValidateNested()
  @Type(() => WebSerialSuggestionQueryDto)
  query?: WebSerialSuggestionQueryDto;

  @IsInt()
  @Min(1)
  seriesRequestId!: number;
}
export class WebSerialDownloadPickDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  downloadClientId?: number | null;

  @IsInt()
  @Min(1)
  indexerId!: number;

  @IsString()
  @Length(1, MAX_INDEXER_RELEASE_GUID_LENGTH)
  releaseGuid!: string;

  @ValidateIf((_object, value) => value !== null)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2000)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(0, { each: true })
  unitIndexes!: number[] | null;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(WEB_SERIAL_MAX_PUBLISHED_VOLUMES, { each: true })
  volumes!: number[];
}
export class WebSerialDownloadDto
  extends PickType(WebSerialPrintSeriesDto, ['title', 'altTitles', 'volumeCount'] as const)
  implements WebSerialDownloadInput
{
  @IsInt()
  @Min(1)
  seriesRequestId!: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  downloadClientId?: number | null;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => WebSerialDownloadPickDto)
  picks!: WebSerialDownloadPickDto[];
}

import { applyDecorators } from '@nestjs/common';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsInt, Min, ValidateIf } from 'class-validator';
import { REQUEST_SOURCE_LIMIT } from '@bookorbit/types';

export function IsRequestSourceIds(): PropertyDecorator {
  return applyDecorators(
    ValidateIf((_object, value) => value !== null),
    IsArray(),
    ArrayMinSize(1),
    ArrayMaxSize(REQUEST_SOURCE_LIMIT),
    ArrayUnique(),
    IsInt({ each: true }),
    Min(1, { each: true }),
  );
}

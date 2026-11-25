import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
@Injectable()
export class KnowledgeTermKeyPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!value || value.length > 200 || !/^[\p{L}\p{N}][\p{L}\p{N} '\u2019-]*$/u.test(value))
      throw new BadRequestException('Invalid knowledge term key');
    return value;
  }
}

import { IsEnum } from 'class-validator';

import type { CrossFormatResumeTarget } from '../reading-alignment-resolve.service';

export class CrossFormatResumeQueryDto {
  // The format the user is opening. Only 'ebook' is supported (resume the reader from newer audiobook
  // progress); the reverse direction is handled eagerly by the progress sync.
  @IsEnum(['ebook'] as const)
  target!: CrossFormatResumeTarget;
}

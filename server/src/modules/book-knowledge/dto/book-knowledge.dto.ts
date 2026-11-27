import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import type { BookKnowledgeScope, BookKnowledgeTermType, BookKnowledgeXrayMode } from '@bookorbit/types';
export class KnowledgeScopeDto {
  @IsOptional() @IsIn(['position', 'full']) scope: BookKnowledgeScope = 'position';
}
export class KnowledgeTermsDto extends KnowledgeScopeDto {
  @IsOptional() @IsIn(['person', 'place', 'concept']) type?: BookKnowledgeTermType;
  @IsOptional() @IsString() @MaxLength(200) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 50;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100000) offset = 0;
}
export class KnowledgeTermParamsDto {
  @IsString() @MinLength(1) @MaxLength(200) @Matches(/^[\p{L}\p{N}][\p{L}\p{N} '\u2019-]*$/u) termKey!: string;
}
export class KnowledgeAskDto {
  @IsString() @MinLength(1) @MaxLength(2000) question!: string;
}
export class KnowledgeBuildDto {}
export class KnowledgeXrayRunDto {
  @Type(() => Number) @IsInt() @Min(1) bookId!: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) through?: number;
  @IsOptional() @IsBoolean() dryRun?: boolean;
  /** Overrides the mode the EPUB's subjects give. */
  @IsOptional() @IsIn(['fiction', 'nonfiction']) mode?: BookKnowledgeXrayMode;
  /** Ignores the answers stored by earlier builds of the book, so a bench run measures every call. */
  @IsOptional() @IsBoolean() fresh?: boolean;
}

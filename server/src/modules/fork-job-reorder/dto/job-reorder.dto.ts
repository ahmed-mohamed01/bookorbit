import { JOB_ID_PATTERN, type JobReorderRequest } from '@bookorbit/types';
import { IsIn, Matches, Validate, ValidatorConstraint, type ValidationArguments, type ValidatorConstraintInterface } from 'class-validator';

@ValidatorConstraint({ name: 'sameJobType' })
class SameJobType implements ValidatorConstraintInterface {
  validate(targetId: unknown, { object }: ValidationArguments): boolean {
    const { id } = object as Partial<JobReorderRequest>;
    return typeof id === 'string' && typeof targetId === 'string' && id.split(':')[0] === targetId.split(':')[0];
  }

  defaultMessage(): string {
    return 'id and targetId must have the same job type';
  }
}

export class JobReorderDto implements JobReorderRequest {
  @Matches(new RegExp(JOB_ID_PATTERN))
  id!: string;

  @Matches(new RegExp(JOB_ID_PATTERN))
  @Validate(SameJobType)
  targetId!: string;

  @IsIn(['before', 'after'])
  place!: JobReorderRequest['place'];
}

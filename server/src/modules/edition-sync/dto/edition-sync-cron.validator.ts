import { ValidateBy, type ValidationOptions } from 'class-validator';
import { CronTime } from 'cron';
import { isFiveFieldCronExpression } from '@bookorbit/types';

// Same rule as library/library-cron.validator.ts; a fork copy so this module does not reach into
// the library module's internals.
export function isValidEditionSyncCronExpression(value: unknown): boolean {
  if (!isFiveFieldCronExpression(value)) return false;
  try {
    new CronTime(value);
    return true;
  } catch {
    return false;
  }
}

export function IsEditionSyncCronExpression(validationOptions?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isEditionSyncCronExpression',
      validator: {
        validate: isValidEditionSyncCronExpression,
        defaultMessage: () => 'cronExpression must be a valid five-field cron expression',
      },
    },
    validationOptions,
  );
}

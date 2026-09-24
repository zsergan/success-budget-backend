import { applyDecorators } from '@nestjs/common';
import { IsDefined, ValidateIf } from 'class-validator';

// @IsOptional() skips validation for null as well as undefined, which lets
// null through to NOT NULL columns. This only skips an absent field.
export const IsOptionalNonNull = () =>
  applyDecorators(
    ValidateIf((_object, value) => value !== undefined),
    IsDefined({ message: '$property must not be null' }),
  );

import { applyDecorators } from '@nestjs/common';
import { IsByteLength, IsString, Matches, MinLength } from 'class-validator';

import { NEW_PASSWORD_MAX_BYTES, NEW_PASSWORD_MIN_LENGTH } from '@shared/constants';

// the rules the mobile client checks before submitting a new password
export const IsNewPassword = () =>
  applyDecorators(
    IsString(),
    MinLength(NEW_PASSWORD_MIN_LENGTH),
    IsByteLength(0, NEW_PASSWORD_MAX_BYTES, {
      message: `$property must be at most ${NEW_PASSWORD_MAX_BYTES} bytes in UTF-8`,
    }),
    Matches(/[A-Za-z]/, { message: '$property must contain a letter' }),
    Matches(/[0-9]/, { message: '$property must contain a digit' }),
  );
